import type { AudioPlan, Instrument, SkillId } from '../../shared/types/course.js';
import type { Snapshot, ToolResult, ToolName } from '../../server/types/agent.types.js';
import type { Transcript } from '../coach/types.js';
import type { Settings } from '../../shared/types/user.js';
import { studioStore } from './store.js';
import type { StudioState, AudioNoticeSurface } from './store.js';
export { useStudio } from './store.js';
import {
  acknowledgePlayback,
  acknowledgeTeaching,
  api,
  callAgentTool,
  callTool,
  getState,
  getCurriculum,
  saveSettings,
  saveTranscript,
} from '../lib/api.js';
import { AudioEngine } from '../audio/audio.js';
import { RealtimeConnection } from '../coach/realtime.js';
import { Conversation } from '../coach/conversation.js';
import { account } from '../auth/auth.js';
import { useAuth } from '../auth/store.js';
import { Log } from '../lib/log.js';
import { ApiError } from '../errors/api-error.js';
import { isFatalError, onFatalError } from '../errors/failure.js';
import type { Session } from '@supabase/supabase-js';
import {
  credentials,
  restoreAccount,
  restoreGuest,
  waitForSaves,
  scope,
} from '../storage/access.js';

interface SectionEntry {
  focus?: SkillId;
  welcome?: boolean;
  mode?: 'coach' | 'solo';
  tutorial?: { discardRoundId: string | null };
}

class Studio {
  private get state() {
    return studioStore.getState();
  }
  private generation = 0;
  private soloTurn = 0;
  private initialized = false;
  private initialization: Promise<boolean> | null = null;
  private identityOperation: Promise<void> | null = null;
  private preview: MediaStream | null = null;
  private previewRequest = 0;
  private microphonePermissionRequest: Promise<void> | null = null;
  private starting: Promise<ToolResult> | null = null;
  private entryController: AbortController | null = null;
  private entryOperation: Promise<void> | null = null;
  private messageTime = 0;
  private readonly captionDeltas = new Map<string, string>();
  private settingsQueue: Promise<void> = Promise.resolve();
  private saving: Promise<void> = Promise.resolve();
  private settingsVersion = 0;
  private previewGeneration = 0;
  private playbackGeneration = 0;

  readonly audio = new AudioEngine((error) => {
    this.patch({ voiceBlocked: true });
    this.reportAudioError(error);
  });
  private readonly transport = new RealtimeConnection({
    event: (event) => this.conversation.handle(event),
    voice: (stream) => {
      void this.audio.attachVoice(stream).catch((error: unknown) => this.reportAudioError(error));
    },
    microphone: (stream) => {
      this.audio.attachMicrophone(stream);
      this.patch({ hasMicrophone: Boolean(stream) });
    },
    microphoneLost: () => {
      this.patch({
        microphoneError: 'Microphone disconnected.',
        micBusy: false,
      });
      void this.refreshDevices();
    },
    disconnected: (message) => {
      this.fail(new Error(message));
    },
  });
  private readonly conversation = new Conversation(this.transport, {
    snapshot: () => this.state.snapshot,
    result: (result) => this.applyResult(result),
    execute: async (name, args, callId) => {
      if (name === 'pause_session' || name === 'end_session') this.cancelEntry();
      if (name === 'start_round') this.prepareRoundRestart();
      try {
        return await callAgentTool(name, args, this.state.snapshot?.session?.id, callId);
      } catch (error) {
        if (name === 'start_round') this.patch({ restartingRound: false });
        if (isFatalError(error)) this.fail(error);
        throw error;
      }
    },
    afterReply: (result, current) => this.afterReply(result, current),
    stopMusic: () => this.audio.stop(),
    phase: (phase) => this.patch({ phase, ...(phase === 'hearing' ? { answerReveal: null } : {}) }),
    message: (role, text, id, complete, interrupted) =>
      this.message(role, text, id, complete, interrupted),
    error: (error) => this.reportError(error instanceof Error ? error : new Error(String(error))),
  });

  constructor() {
    onFatalError((error) => this.fail(error));
  }
  getSnapshot = studioStore.getState;
  private patch(update: Partial<StudioState>) {
    studioStore.setState(update);
  }
  reportError(error: unknown) {
    if (isFatalError(error)) {
      this.fail(error);
      return;
    }
    Log.error('app.action_failed', error);
    this.patch({
      error: error instanceof Error ? error.message : 'This action could not be completed.',
    });
  }
  dismissError() {
    this.patch({ error: null, notice: null });
  }
  fail(error: unknown) {
    if (this.state.fatalError || (error instanceof DOMException && error.name === 'AbortError'))
      return;
    Log.error('app.fatal', error, { connection: this.state.connection, phase: this.state.phase });
    this.cancelEntry();
    ++this.generation;
    this.disconnect();
    this.stopMicrophonePreview();
    this.patch({
      fatalError: { code: error instanceof ApiError ? error.code : 'unexpected_error' },
      connection: 'error',
      busy: false,
      loading: false,
      entering: false,
      restartingRound: false,
      error: null,
    });
    void Log.flush();
  }
  private audioSurface(): AudioNoticeSurface {
    return this.state.setupOpen ? 'setup' : 'lesson';
  }
  private audioNotice(
    message: string,
    kind: 'error' | 'notice' = 'notice',
    surface = this.audioSurface(),
  ) {
    this.patch({ audioNotices: { ...this.state.audioNotices, [surface]: { message, kind } } });
  }
  private reportAudioError(error: unknown, surface = this.audioSurface()) {
    this.audioNotice(
      error instanceof Error ? error.message : 'Audio could not be prepared.',
      'error',
      surface,
    );
  }
  dismissAudioNotice(surface: AudioNoticeSurface) {
    this.patch({ audioNotices: { ...this.state.audioNotices, [surface]: null } });
  }
  initialize(): Promise<boolean> {
    if (this.state.fatalError) return Promise.resolve(false);
    if (this.initialization) return this.initialization;
    if (this.identityOperation)
      return this.identityOperation.then(() =>
        Boolean(this.state.snapshot && this.state.curriculum && !this.state.loading),
      );
    if (this.state.snapshot && this.state.curriculum && !this.state.loading)
      return Promise.resolve(true);
    const operation = this.bootstrap();
    this.initialization = operation;
    void operation.then(() => {
      if (this.initialization === operation) this.initialization = null;
    });
    return operation;
  }
  private async bootstrap(): Promise<boolean> {
    const generation = this.generation;
    if (!this.initialized) {
      this.initialized = true;
      Log.initialize({
        session: () => this.state.snapshot?.session?.id ?? this.state.lastSession?.id ?? null,
        access: () => {
          const current = credentials();
          return { identity: current.identity, headers: current.headers };
        },
      });
      window.addEventListener('error', (event) => {
        if (event.error) this.fail(event.error);
      });
      window.addEventListener('unhandledrejection', (event) => {
        if (!(event.reason instanceof DOMException && event.reason.name === 'AbortError'))
          this.fail(event.reason);
      });
      window.addEventListener('offline', () => {
        if (this.state.connection === 'connected' || this.state.busy)
          this.fail(ApiError.unreachable());
      });
      window.addEventListener('pagehide', () => {
        this.cancelEntry();
        ++this.generation;
        this.disconnect();
        this.stopMicrophonePreview();
        this.patch({ busy: false, loading: false, setupOpen: true, setupComplete: false });
      });
      const resumeAudio = () => {
        if (this.state.fatalError) return;
        void this.audio
          .resumeOnGesture()
          .then(async () => {
            if (this.state.voiceBlocked) {
              await this.audio.enableVoiceOutput();
              this.patch({ voiceBlocked: false });
              this.dismissAudioNotice(this.audioSurface());
            }
          })
          .catch((error: unknown) => this.reportAudioError(error));
      };
      window.addEventListener('pointerdown', resumeAudio);
      window.addEventListener('keydown', resumeAudio);
      navigator.mediaDevices?.addEventListener('devicechange', () => {
        void this.refreshDevices();
      });
      try {
        this.patch({
          microphoneDevice: localStorage.getItem('earrr:microphone') || 'none',
          speakerDevice: localStorage.getItem('earrr:speaker') || '',
        });
      } catch {
        this.audioNotice(
          'Audio device choices cannot be remembered in this browser.',
          'notice',
          'setup',
        );
      }
      void this.requestEntryMicrophonePermission();
      void this.refreshDevices();
    }
    this.patch({ loading: true, error: null });
    try {
      const session = await account.initialize({
        pause: () => this.pauseForAccount(),
        identity: (current, migrate) => this.changeIdentity(current, migrate),
      });
      const snapshot = await (useAuth.getState().config?.guestStorage
        ? session
          ? restoreAccount(session, account.needsGuestTransfer())
          : restoreGuest()
        : getState());
      const curriculum = await getCurriculum();
      if (generation !== this.generation) return false;
      this.patch({ curriculum });
      this.applySnapshot(snapshot);
      this.patch({ loading: false, error: null, setupOpen: true, setupComplete: false });
      Log.event('app.ready', {
        authenticated: Boolean(session),
        lessonId: snapshot.course.selectedLesson,
      });
      if (session) account.completedGuestTransfer();
      return true;
    } catch (error) {
      if (generation === this.generation) {
        this.patch({ loading: false });
        this.reportError(error);
      }
      return false;
    }
  }
  private async pauseForAccount() {
    this.cancelEntry();
    ++this.generation;
    this.disconnect();
    this.stopMicrophonePreview();
    await this.initialization;
    await this.saving;
    if (!this.state.snapshot) {
      this.patch({ busy: false, loading: false, setupOpen: true, setupComplete: false });
      return;
    }
    await waitForSaves();
    const snapshot = await getState();
    if (snapshot.session?.status === 'active') {
      this.applySnapshot((await callTool('pause_session', {}, snapshot.session.id)).snapshot);
    } else this.applySnapshot(snapshot);
    this.patch({ busy: false, setupOpen: true, setupComplete: false });
  }
  private changeIdentity(session: Session | null, migrate: boolean) {
    const operation = this.applyIdentity(session, migrate);
    this.identityOperation = operation;
    const finished = () => {
      if (this.identityOperation === operation) this.identityOperation = null;
    };
    void operation.then(finished, finished);
    return operation;
  }
  private async applyIdentity(session: Session | null, migrate: boolean) {
    this.cancelEntry();
    ++this.generation;
    this.disconnect();
    this.stopMicrophonePreview();
    await this.initialization;
    await this.saving;
    await waitForSaves();
    this.patch({
      snapshot: null,
      messages: [],
      answerReveal: null,
      lastSession: null,
      audioNotices: { setup: null, lesson: null },
      restartingRound: false,
      loading: true,
      busy: false,
    });
    try {
      const snapshot = session ? await restoreAccount(session, migrate) : await restoreGuest(true);
      if (!this.state.curriculum) this.patch({ curriculum: await getCurriculum() });
      this.applySnapshot(snapshot);
      this.patch({
        loading: false,
        setupOpen: true,
        setupComplete: false,
        error: null,
      });
    } catch (error) {
      this.patch({ loading: false });
      this.reportError(error);
      throw error;
    }
  }
  async refresh() {
    if (this.state.fatalError) return;
    if (!this.state.snapshot) {
      this.patch({ loading: true, error: null });
      await this.initialize();
      return;
    }
    try {
      const [snapshot, curriculum] = await Promise.all([
        getState(),
        this.state.curriculum ? Promise.resolve(this.state.curriculum) : getCurriculum(),
      ]);
      this.patch({ curriculum });
      this.applySnapshot(snapshot);
      this.patch({ loading: false, error: null });
    } catch (error) {
      this.patch({ loading: false });
      this.reportError(error);
    }
  }
  private applySnapshot(snapshot: Snapshot) {
    if (this.state.fatalError) return;
    const nextId = snapshot.session?.id;
    const changedLesson =
      nextId !== this.state.snapshot?.session?.id ||
      snapshot.course.selectedLesson !== this.state.snapshot?.course.selectedLesson;
    this.audio.setVolume(snapshot.settings.volume);
    const messages = new Map(
      [...(snapshot.transcript ?? []), ...this.state.messages].map((message) => [
        message.id,
        message,
      ]),
    );
    this.patch({
      snapshot,
      messages: [...messages.values()]
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(-100),
      lastSession: snapshot.session ?? snapshot.recentSessions[0] ?? null,
      ...(changedLesson ? { answerReveal: null } : {}),
    });
  }
  private applyResult(result: ToolResult) {
    this.applySnapshot(result.snapshot);
    if (!result.snapshot.session?.awaitingRoundChoice) this.patch({ restartingRound: false });
    if (result.teaching) this.patch({ answerReveal: null });
    const feedback = result.snapshot.feedback;
    if (
      !result.review &&
      feedback &&
      ((result.grade &&
        result.grade.verdict !== 'incomplete' &&
        feedback.exerciseId === result.gradedExerciseId) ||
        result.playbackExerciseId === feedback.exerciseId)
    ) {
      this.patch({
        answerReveal: {
          ...feedback,
          roundResult: result.roundResult,
        },
      });
    }
  }
  async updateSettings(updates: Partial<Settings>) {
    const surface = this.audioSurface();
    const previous = this.state.snapshot?.settings;
    if (!previous || !this.state.snapshot) return false;
    const settings = { ...previous, ...updates };
    const version = ++this.settingsVersion;
    this.audio.setVolume(settings.volume);
    this.patch({ snapshot: { ...this.state.snapshot, settings } });
    let success = false;
    this.settingsQueue = this.settingsQueue.then(async () => {
      try {
        const saved = await saveSettings(settings);
        if (this.state.snapshot && version === this.settingsVersion)
          this.patch({ snapshot: { ...this.state.snapshot, settings: saved.settings } });
        success = true;
      } catch (error) {
        if (version === this.settingsVersion && this.state.snapshot) {
          this.patch({ snapshot: { ...this.state.snapshot, settings: previous } });
          this.audio.setVolume(previous.volume);
        }
        this.reportAudioError(error, surface);
      }
    });
    await this.settingsQueue;
    return success;
  }

  async refreshDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const devices = await Promise.race([
        navigator.mediaDevices.enumerateDevices(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Device discovery timed out.')), 6000);
        }),
      ]);
      this.patch({ devices });
      if (!devices.some((device) => device.kind === 'audioinput') && !this.state.hasMicrophone) {
        this.patch({ microphoneDevice: 'none' });
      }
    } catch {
      this.audioNotice('Could not refresh audio devices. You can still enter and type.');
    } finally {
      clearTimeout(timer);
    }
  }
  async startTraining(loadView: () => Promise<void>) {
    if (this.state.busy || this.state.fatalError) return;
    Log.event('training.start_clicked', {
      mode: this.state.snapshot?.session?.mode,
      microphone: this.state.previewingMicrophone,
    });
    const generation = this.generation;
    const input = this.state.previewingMicrophone || this.state.hasMicrophone ? 'voice' : 'text';
    this.previewGeneration++;
    // Audio is activated in the entry click, before asynchronous API work.
    void this.audio.unlock().catch((error: unknown) => this.reportAudioError(error, 'setup'));
    this.stopMicrophonePreview();
    this.audio.stop();
    this.patch({ busy: true, notice: null });
    try {
      const [ready] = await Promise.all([this.initialize(), loadView()]);
      if (generation !== this.generation) return;
      if (!ready) {
        this.patch({ busy: false, setupComplete: false });
        return;
      }
      await this.settingsQueue;
      if (generation !== this.generation) return;
      this.patch({ busy: false, setupComplete: true });
      await this.start(
        this.state.snapshot?.session?.mode ?? (this.state.snapshot?.configured ? 'coach' : 'solo'),
        input,
      );
    } catch (error) {
      if (generation === this.generation) {
        this.reportError(error);
        this.patch({ busy: false, setupComplete: false });
      }
    }
  }
  private remember(key: string, value: string) {
    try {
      localStorage.setItem(`earrr:${key}`, value);
    } catch {
      this.audioNotice('The audio choice applies for this visit but could not be saved.');
    }
  }
  async chooseSpeaker(speakerDevice: string) {
    const surface = this.audioSurface();
    try {
      let selected = speakerDevice;
      try {
        await this.audio.setOutputDevice(selected);
      } catch (error) {
        const devices = navigator.mediaDevices;
        if (
          !(error instanceof DOMException && error.name === 'NotAllowedError') ||
          !selected ||
          !devices ||
          !('selectAudioOutput' in devices) ||
          typeof devices.selectAudioOutput !== 'function'
        )
          throw error;
        const output: MediaDeviceInfo = await devices.selectAudioOutput({ deviceId: selected });
        selected = output.deviceId;
        await this.audio.setOutputDevice(selected);
      }
      this.patch({ speakerDevice: selected });
      this.dismissAudioNotice(surface);
      this.remember('speaker', selected);
      Log.event('audio.output_selected', { systemDefault: selected === '' });
      void this.refreshDevices();
    } catch (error) {
      this.reportAudioError(error, surface);
    }
  }
  async chooseMicrophone(microphoneDevice: string) {
    if (this.state.fatalError) return;
    Log.event('audio.input_selected', { enabled: microphoneDevice !== 'none' });
    this.patch({ microphoneDevice, microphoneError: null });
    this.remember('microphone', microphoneDevice);
    if (microphoneDevice === 'none') {
      this.stopMicrophonePreview();
      try {
        await this.transport.disableMicrophone();
      } catch (error) {
        this.reportError(error);
      }
      return;
    }
    if (this.transport.connected) {
      try {
        this.patch({ micBusy: true });
        await this.transport.enableMicrophone(microphoneDevice);
      } catch (error) {
        this.microphoneError(error);
      } finally {
        this.patch({ micBusy: false });
      }
    } else if (this.state.setupOpen) await this.previewMicrophone();
  }
  private microphoneError(error: unknown) {
    Log.event(
      'audio.input_failed',
      { code: error instanceof Error ? error.name : 'UnknownError' },
      { level: 'warn' },
    );
    const message =
      error instanceof DOMException && error.name === 'NotAllowedError'
        ? 'Microphone access was denied. Allow it in your browser to enable voice input.'
        : error instanceof DOMException &&
            ['NotFoundError', 'OverconstrainedError'].includes(error.name)
          ? 'The selected microphone is unavailable.'
          : error instanceof Error
            ? `Microphone unavailable: ${error.message}`
            : 'Microphone unavailable.';
    if (!(error instanceof DOMException && error.name === 'AbortError'))
      this.patch({ microphoneError: message });
  }
  private async requestEntryMicrophonePermission() {
    await this.requestMicrophonePermission(false);
  }
  requestMicrophonePermission(retryBlocked = true): Promise<void> {
    if (this.microphonePermissionRequest) return this.microphonePermissionRequest;
    const operation = this.acquireMicrophonePermission(retryBlocked);
    this.microphonePermissionRequest = operation;
    const finished = () => {
      if (this.microphonePermissionRequest === operation) this.microphonePermissionRequest = null;
    };
    void operation.then(finished, finished);
    return operation;
  }
  private async acquireMicrophonePermission(retryBlocked: boolean) {
    if (!navigator.mediaDevices?.getUserMedia) return;
    if (navigator.permissions?.query) {
      try {
        const permission = await navigator.permissions.query({
          name: 'microphone' as PermissionName,
        });
        if (permission.state === 'granted') return;
        if (permission.state === 'denied' && !retryBlocked) {
          return;
        }
      } catch (error) {
        if (
          !(
            error instanceof TypeError ||
            (error instanceof DOMException && error.name === 'NotSupportedError')
          )
        ) {
          this.microphoneError(error);
          return;
        }
      }
    }
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'NotFoundError'))
        this.microphoneError(error);
    } finally {
      stream?.getTracks().forEach((track) => track.stop());
      void this.refreshDevices();
    }
  }
  private selectedInput(): string | null {
    if (!navigator.mediaDevices?.getUserMedia) return null;
    const selected = this.state.microphoneDevice;
    return this.state.devices.some(
      (device) =>
        device.kind === 'audioinput' &&
        device.deviceId === selected &&
        !['', 'none', 'default', 'communications'].includes(selected),
    )
      ? selected
      : null;
  }
  async previewMicrophone() {
    if (this.transport.connected) {
      await this.toggleMicrophone();
      return;
    }
    const device = this.selectedInput();
    if (device === null) {
      this.patch({ microphoneError: 'No microphone detected.' });
      return;
    }
    const request = ++this.previewRequest;
    this.patch({ micBusy: true });
    try {
      await this.audio.unlock();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: device ? { exact: device } : undefined,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      if (request !== this.previewRequest || !this.state.setupOpen) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.preview?.getTracks().forEach((track) => track.stop());
      this.preview = stream;
      this.audio.attachMicrophone(stream);
      this.patch({ previewingMicrophone: true, microphoneDevice: device, microphoneError: null });
      this.remember('microphone', device);
      void this.refreshDevices();
    } catch (error) {
      if (request === this.previewRequest) this.microphoneError(error);
    } finally {
      if (request === this.previewRequest) this.patch({ micBusy: false });
    }
  }
  stopMicrophonePreview() {
    this.previewRequest++;
    this.preview?.getTracks().forEach((track) => track.stop());
    this.preview = null;
    if (!this.transport.connected) this.audio.attachMicrophone(null);
    this.patch({ previewingMicrophone: false, micBusy: false });
  }
  async toggleMicrophone() {
    if (!this.transport.connected) return;
    if (this.state.hasMicrophone || this.state.micBusy) {
      await this.transport.disableMicrophone();
      this.patch({ micBusy: false });
      return;
    }
    const device = this.selectedInput();
    if (device === null) {
      this.patch({
        microphoneError: 'No microphone detected.',
      });
      return;
    }
    this.patch({ micBusy: true });
    try {
      await this.transport.enableMicrophone(device);
      this.patch({ microphoneDevice: device, microphoneError: null });
    } catch (error) {
      this.microphoneError(error);
    } finally {
      this.patch({ micBusy: false });
    }
  }

  async start(
    mode: 'coach' | 'solo' = 'coach',
    input?: 'voice' | 'text',
    focus?: SkillId,
    tutorial?: { discardRoundId: string | null },
    welcome = false,
  ) {
    if (this.state.busy || this.state.loading || this.state.fatalError) return;
    if (!this.state.setupComplete) {
      this.patch({ setupOpen: true });
      return;
    }
    const generation = ++this.generation;
    this.patch({
      busy: true,
      error: null,
      notice: null,
      voiceBlocked: false,
      ...(mode === 'coach'
        ? {
            connection: this.state.snapshot?.session
              ? ('reconnecting' as const)
              : ('connecting' as const),
            phase: 'connecting' as const,
          }
        : {}),
    });
    try {
      if (mode === 'coach') void this.prepareAudio(generation);
      else await this.audio.setOutputDevice(this.state.speakerDevice);
      if (generation !== this.generation) return;
      let session = this.state.snapshot?.session;
      if (session && session.mode !== mode) {
        this.applySnapshot((await callTool('end_session', {}, session.id)).snapshot);
        this.disconnect();
        session = null;
      }
      this.starting = callTool(
        'start_session',
        {
          mode,
          ...(focus ? { focus } : {}),
          ...(welcome ||
          (mode === 'coach' && !focus && !tutorial && !this.state.snapshot?.course.welcomeSeen)
            ? { welcome: true }
            : {}),
        },
        session?.id,
      );
      const result = await this.starting;
      this.starting = null;
      if (generation !== this.generation) return;
      this.applySnapshot(result.snapshot);
      session = result.snapshot.session!;
      if (session.status === 'paused')
        this.applySnapshot((await callTool('resume_session', {}, session.id)).snapshot);
      if (generation !== this.generation) return;
      if (welcome && this.state.snapshot?.teaching?.section !== 'welcome') {
        const introduction = await callTool('show_welcome', {}, session.id);
        if (generation !== this.generation) return;
        this.applySnapshot(introduction.snapshot);
      } else if (tutorial) {
        const teaching = await callTool('teach_lesson', { restart: true, ...tutorial }, session.id);
        if (generation !== this.generation) return;
        this.applySnapshot(teaching.snapshot);
      }
      if (mode === 'solo') {
        const snapshot = this.state.snapshot!;
        if (
          !snapshot.teaching &&
          (snapshot.session?.awaitingRoundChoice ||
            (snapshot.current && snapshot.current.status !== 'unanswered'))
        )
          this.patch({ setupOpen: false, busy: false, phase: 'listening' });
        else await this.soloAction('play_exercise', {}, true);
      } else await this.connect(session.id, input ?? 'text', generation);
    } catch (error) {
      if (generation === this.generation) {
        this.disconnect();
        this.patch({ connection: 'error' });
        this.reportError(error);
      }
    } finally {
      if (generation === this.generation) this.patch({ busy: false });
    }
  }
  private cancelEntry() {
    this.entryController?.abort();
    this.entryController = null;
    this.entryOperation = null;
    this.patch({ entering: false });
  }
  enterSection(options: SectionEntry = {}): Promise<void> {
    if (this.entryOperation) return this.entryOperation;
    if (
      this.state.fatalError ||
      !this.state.snapshot ||
      this.state.loading ||
      this.state.busy ||
      this.state.setupOpen ||
      !this.state.setupComplete ||
      useAuth.getState().busy ||
      useAuth.getState().view
    )
      return Promise.resolve();
    const session = this.state.snapshot.session;
    const mode =
      options.mode ?? session?.mode ?? (this.state.snapshot.configured ? 'coach' : 'solo');
    const targeted = Boolean(options.focus || options.welcome || options.tutorial);
    if (!targeted && session?.status === 'active') {
      if (mode === 'coach' && this.transport.connected) return Promise.resolve();
      if (mode === 'solo' && this.state.phase !== 'ready') return Promise.resolve();
    }
    const owner = scope();
    const controller = new AbortController();
    this.entryController = controller;
    const active = () =>
      !controller.signal.aborted &&
      scope() === owner &&
      !this.state.fatalError &&
      !this.state.setupOpen &&
      !useAuth.getState().view &&
      !useAuth.getState().busy;
    const run = async () => {
      this.patch({ entering: true });
      try {
        if (active()) {
          const current = this.state.snapshot?.session;
          if (mode === 'solo' && current?.mode === 'solo' && !targeted) {
            if (current.status === 'paused') {
              this.applySnapshot((await callTool('resume_session', {}, current.id)).snapshot);
              if (!active()) return;
            }
            const snapshot = this.state.snapshot!;
            if (
              !snapshot.session?.awaitingRoundChoice &&
              (snapshot.teaching || !snapshot.current || snapshot.current.status === 'unanswered')
            ) {
              await this.audio.setOutputDevice(this.state.speakerDevice);
              if (active()) await this.soloAction('play_exercise', {});
            }
            return;
          }
          await this.start(
            mode,
            this.state.microphoneDevice === 'none' ? 'text' : 'voice',
            options.focus,
            options.tutorial,
            Boolean(options.welcome),
          );
        }
      } catch (error) {
        if (active()) this.reportError(error);
      } finally {
        if (this.entryController === controller) {
          this.entryController = null;
          this.patch({ entering: false });
        }
      }
    };
    const operation = run();
    this.entryOperation = operation;
    void operation.finally(() => {
      if (this.entryOperation === operation) this.entryOperation = null;
    });
    return operation;
  }
  private async connect(sessionId: string, input: 'voice' | 'text', generation: number) {
    Log.event('realtime.connect_started', { sessionId, input });
    this.conversation.reset();
    this.patch({ connection: 'connecting', phase: 'connecting' });
    await this.transport.connect(sessionId);
    if (generation !== this.generation) return;
    this.patch({ connection: 'connected', phase: 'thinking', busy: false, setupOpen: false });
    Log.event('realtime.connected', { sessionId, input });
    this.conversation.start();
    if (input === 'voice') void this.toggleMicrophone();
  }
  private async prepareAudio(generation: number) {
    const device = this.state.speakerDevice;
    const surface = this.audioSurface();
    try {
      await this.audio.setOutputDevice(device);
    } catch (error) {
      if (generation !== this.generation || this.state.connection === 'error') return;
      if (device) {
        this.patch({
          speakerDevice: '',
        });
        this.audioNotice(
          'The saved speaker is unavailable. Using the system default.',
          'notice',
          surface,
        );
        this.remember('speaker', '');
        try {
          await this.audio.setOutputDevice('');
          return;
        } catch (fallbackError) {
          error = fallbackError;
        }
      }
      if (generation === this.generation) {
        this.patch({ voiceBlocked: true });
        this.reportAudioError(error, surface);
      }
    }
  }
  private disconnect() {
    this.soloTurn++;
    this.conversation.reset();
    this.captionDeltas.clear();
    this.transport.disconnect();
    this.audio.stop();
    ++this.playbackGeneration;
    this.patch({ musicPlayback: null });
    this.audio.detachVoice();
    this.patch({
      connection: 'disconnected',
      phase: 'ready',
      hasMicrophone: false,
      micBusy: false,
      answerReveal: null,
    });
  }
  async stop() {
    this.cancelEntry();
    ++this.generation;
    let session = this.state.snapshot?.session;
    this.disconnect();
    this.patch({ busy: true });
    try {
      if (this.starting) session = (await this.starting).snapshot.session;
      if (session) this.applySnapshot((await callTool('end_session', {}, session.id)).snapshot);
      this.patch({ notice: null });
    } catch (error) {
      this.reportError(error);
    } finally {
      this.starting = null;
      this.patch({ busy: false });
    }
  }
  async enableAudio(surface = this.audioSurface()) {
    try {
      await this.audio.unlock();
      await this.audio.enableVoiceOutput();
      this.patch({ voiceBlocked: false });
      this.dismissAudioNotice(surface);
    } catch (error) {
      this.reportAudioError(error, surface);
    }
  }
  async chooseInstrument(instrument: Instrument) {
    if (this.state.setupOpen) {
      this.previewGeneration++;
      this.audio.stop();
    }
    await this.updateSettings({ instrument });
  }
  async previewNote(midi: number) {
    if (!this.state.setupOpen || this.transport.connected || !this.state.snapshot) return;
    const generation = this.generation;
    const previewGeneration = this.previewGeneration;
    const instrument = this.state.snapshot.settings.instrument;
    try {
      await this.audio.setOutputDevice(this.state.speakerDevice);
      if (
        !this.state.setupOpen ||
        generation !== this.generation ||
        previewGeneration !== this.previewGeneration
      )
        return;
      await this.audio.previewNote(midi, instrument);
    } catch (error) {
      this.reportAudioError(error, 'setup');
    }
  }

  async send(text: string): Promise<boolean> {
    const session = this.state.snapshot?.session;
    if (!session || !text.trim() || this.state.fatalError) return false;
    Log.event('input.submitted', {
      input: 'text',
      characters: text.trim().length,
      mode: session.mode,
    });
    this.patch({ error: null, answerReveal: null });
    if (session.mode === 'coach') {
      if (!this.transport.connected) {
        this.fail(new Error('The coach connection is not available.'));
        return false;
      }
      this.conversation.text(text.trim());
      return true;
    } else {
      const current = this.state.snapshot?.current;
      if (!current || current.status !== 'unanswered') {
        this.patch({ notice: 'Play the next question before answering.' });
        return false;
      }
      const turn = ++this.soloTurn;
      const generation = this.generation;
      this.audio.stop();
      const callId = crypto.randomUUID();
      this.message('user', text.trim(), `solo-user:${callId}`, true);
      try {
        const result = await api<ToolResult>('/solo/answer', {
          method: 'POST',
          body: JSON.stringify({
            callId,
            sessionId: session.id,
            exerciseId: current.id,
            text: text.trim(),
          }),
        });
        if (
          turn !== this.soloTurn ||
          generation !== this.generation ||
          this.state.snapshot?.session?.id !== session.id
        )
          return false;
        this.applyResult(result);
        this.message(
          'assistant',
          result.grade?.feedback ?? result.message,
          `solo-coach:${callId}`,
          true,
        );
        return true;
      } catch (error) {
        this.reportError(error);
        return false;
      }
    }
  }
  async action(name: ToolName, args: Record<string, unknown> = {}) {
    if (this.state.fatalError) return;
    Log.event('action.requested', {
      action: name,
      lessonId: this.state.snapshot?.course.selectedLesson,
    });
    if (name === 'pause_session' || name === 'end_session') this.cancelEntry();
    const session = this.state.snapshot?.session;
    if (!session) return;
    if (['give_hint', 'skip_exercise'].includes(name))
      args = { exerciseId: this.state.snapshot?.current?.id ?? crypto.randomUUID(), ...args };
    if (session.mode === 'coach' && this.transport.connected)
      await this.conversation.action(name, args);
    else await this.soloAction(name, args);
  }
  async focus(skillId: SkillId) {
    if (this.state.fatalError) return;
    Log.event('lesson.selected', {
      lessonId: skillId,
      previousLessonId: this.state.snapshot?.course.selectedLesson,
    });
    this.cancelEntry();
    if (this.state.connection === 'connected') {
      await this.action('select_lesson', { skillId });
      return;
    }
    const turn = ++this.soloTurn;
    this.audio.stop();
    try {
      const result = await callTool('select_lesson', { skillId }, this.state.snapshot?.session?.id);
      if (turn !== this.soloTurn) return;
      this.applySnapshot(result.snapshot);
      await this.enterSection({ focus: skillId });
    } catch (error) {
      this.reportError(error);
    }
  }
  async skipTeaching() {
    await this.action('start_practice');
  }
  async welcome() {
    if (this.state.busy || this.state.loading || this.state.fatalError) return;
    Log.event('lesson.selected', { lessonId: 'welcome' });
    this.cancelEntry();
    if (this.state.connection === 'connected') {
      await this.action('show_welcome');
      return;
    }
    await this.enterSection({ welcome: true });
  }
  async startRound() {
    if (this.state.restartingRound) return;
    this.prepareRoundRestart();
    try {
      await this.action('start_round');
    } finally {
      this.patch({ restartingRound: false });
    }
  }
  private prepareRoundRestart() {
    this.audio.stop();
    this.patch({ restartingRound: true, answerReveal: null, phase: 'listening' });
  }
  async openTutorial(discardRoundId: string | null) {
    if (this.state.busy || !this.state.snapshot?.configured) return;
    if (this.transport.connected)
      await this.action('teach_lesson', { restart: true, discardRoundId });
    else await this.enterSection({ mode: 'coach', tutorial: { discardRoundId } });
  }
  private async soloAction(name: ToolName, args: Record<string, unknown>, enterTraining = false) {
    const session = this.state.snapshot?.session;
    if (!session) return;
    const turn = ++this.soloTurn;
    const generation = this.generation;
    const isCurrent = () =>
      turn === this.soloTurn &&
      generation === this.generation &&
      this.state.snapshot?.session?.id === session.id;
    try {
      this.audio.stop();
      let result: ToolResult | null = await callTool(name, args, session.id);
      if (!isCurrent()) return;
      if (name === 'resume_session') {
        this.applyResult(result);
        result = await callTool('play_exercise', {}, session.id);
      }
      while (result && isCurrent()) {
        this.applyResult(result);
        if (enterTraining) this.patch({ setupOpen: false, busy: false });
        const text =
          result.hint ??
          result.grade?.feedback ??
          result.snapshot.current?.prompt ??
          result.message;
        if (!result.review) this.message('assistant', text, crypto.randomUUID(), true);
        result = await this.afterReply(result, isCurrent);
      }
    } catch (error) {
      if (isCurrent()) this.reportError(error);
    }
  }
  private async play(plan: AudioPlan, sessionId: string, exerciseId?: string, replay = false) {
    const playback = ++this.playbackGeneration;
    Log.event('audio.started', {
      questionId: exerciseId,
      replay,
      instrument: plan.instrument,
      durationSeconds: plan.duration,
    });
    this.patch({
      phase: 'playing',
      musicPlayback: { exerciseId, replay },
      ...(exerciseId !== this.state.answerReveal?.exerciseId ? { answerReveal: null } : {}),
    });
    try {
      const finished = await this.audio.play(plan, () => {
        if (exerciseId)
          void acknowledgePlayback(sessionId, exerciseId).catch((error: unknown) =>
            this.reportError(error),
          );
      });
      Log.event('audio.finished', { questionId: exerciseId, replay, completed: finished });
      if (playback === this.playbackGeneration && finished && this.state.phase === 'playing')
        this.patch({ phase: 'listening' });
      return finished;
    } finally {
      if (playback === this.playbackGeneration) this.patch({ musicPlayback: null });
    }
  }
  private async afterReply(
    result: ToolResult | null,
    isCurrent: () => boolean,
  ): Promise<ToolResult | null> {
    if (!result || this.state.fatalError) return null;
    if (result.endConversation) {
      this.cancelEntry();
      this.disconnect();
      this.patch({ notice: null });
      return null;
    }
    const session = this.state.snapshot?.session;
    if (!session || (session.status !== 'active' && !result.review)) return null;
    if (
      result.audio &&
      !(await this.play(
        result.audio,
        session.id,
        result.playbackExerciseId,
        result.reply === 'none' && !result.teaching,
      ))
    )
      return null;
    if (!isCurrent()) return null;
    if (!result.teaching) return null;
    const teaching = result.teaching;
    const snapshot = await acknowledgeTeaching(session.id, teaching.presentationId);
    if (!isCurrent()) return null;
    this.applySnapshot(snapshot);
    return teaching.autoContinue
      ? callTool('continue_teaching', { presentationId: teaching.presentationId }, session.id)
      : null;
  }

  private message(
    role: Transcript['role'],
    text: string,
    id: string,
    complete: boolean,
    interrupted = false,
  ) {
    if (this.state.fatalError) return;
    const sessionId = this.state.snapshot?.session?.id ?? this.state.lastSession?.id;
    if (!sessionId || !text.trim()) return;
    if (role === 'user' && !complete && text !== 'Listening…') {
      text = (this.captionDeltas.get(id) ?? '') + text;
      this.captionDeltas.set(id, text);
    }
    if (complete) this.captionDeltas.delete(id);
    if (role === 'user' && complete && id.startsWith('user:'))
      Log.event('input.submitted', { input: 'voice', characters: text.length });
    const previous = this.state.messages.find((message) => message.id === id);
    this.messageTime = Math.max(Date.now(), this.messageTime + 1);
    const message: Transcript = {
      id,
      sessionId,
      role,
      text: text.slice(0, 8000),
      createdAt: previous?.createdAt ?? new Date(this.messageTime).toISOString(),
      ...(role === 'assistant' && complete
        ? { delivery: interrupted ? ('interrupted' as const) : ('spoken' as const) }
        : {}),
    };
    const messages = previous
      ? this.state.messages.map((item) => (item.id === id ? message : item))
      : [...this.state.messages, message];
    this.patch({
      messages: messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-100),
    });
    if (complete) {
      const owner = scope();
      this.saving = this.saving
        .then(async () => {
          if (scope() !== owner) throw new Error('The account changed before chat could be saved.');
          await saveTranscript(message);
        })
        .catch((error: unknown) => {
          if (scope() === owner)
            this.patch({
              notice: `Conversation could not be saved: ${error instanceof Error ? error.message : 'storage error'}. Learning progress is saved separately.`,
            });
        });
    }
  }
}

export const studio = new Studio();
