# Product

## Register

product

## Users

Musicians who want sustained, serious ear training while working in another
application. The initial product is a single-player, locally hosted desktop
application for Chrome and Edge, with browser-local guests and verified Supabase
accounts for durable cloud progress. The player can listen and speak without
watching the dashboard, with equivalent text input when speaking is unsuitable.

## Product Purpose

Provide a persistent, conversational ear-training coach that manages exercises,
understands contextual requests, and builds long-term musical fluency. Success
means that the player can start a session, switch applications, and continue
practicing naturally without memorizing commands or repeatedly touching the UI.

The musical engine owns exercise construction and correctness. The AI owns
conversation and coaching, but cannot invent scores or override known musical
ground truth. Progress is durable and reflects demonstrated learning.

## Brand Personality

Precise, focused, discerning. A conservatory-style practice instrument, not a
cartoon tutor or a punitive examiner. Feedback is specific and encouraging
without excessive praise. The player is treated as a musician at every level.

## Anti-references

- Click-dependent multiple-choice quizzes and command memorization.
- Noisy game dashboards that demand attention during another task.
- Inflated streaks, fabricated progress, urgency, and punishment for silence.
- An AI chat panel attached superficially to a conventional quiz.
- Decorative interfaces that obscure microphone, playback, or connection state.

## Design Principles

1. Audio is the primary interface. The dashboard supports occasional glances.
2. Musical truth is deterministic, contextual, and separate from the AI.
3. Waiting is normal. Replays are free, and delayed answers are not penalized.
4. Track retained skill and meaningful practice, not points or mechanical clicks.
   There is no XP or achievement-reward system.
5. Practice one selected lesson at a time. Randomize within the lesson, never
   silently move between chapters. Recommend the next lesson after a clear
   checkpoint. Guided next-lesson and next-chapter progression is locked until
   an explicit 8/10 round is passed; completed lessons can be reviewed.
6. Treat connection errors, permissions, and interruptions as first-class states.
7. Generate fresh musical contexts. Never let a predictable question order or a
   small memorized answer bank substitute for hearing. Replays remain identical,
   while mastery requires transfer across roots, registers, and practice days.
8. Use a unified light monochrome workspace with compact, resizable exercise and
   conversation panels. Training fits the viewport, including mobile: compact
   layouts share the exercise/history area above a latest-message and input dock.
   Preserve drafts and audio when switching views. Remove redundant status labels, slogans, dividers, and footer
   transports. Keep the current question and conversation prominent.
9. Show a Teams-style microphone/speaker setup on entry. Local microphone preview
   requires consent and sends no audio to Azure. Coach voice is audible by
   default. Desktop entry is two columns, instrument left and devices right,
   with one training action. A large Earrr wordmark image and "Ear training game with
   a friendly AI tutor." sit above the left side; compact layouts stack.
   Group the logo, a larger styled two-line subtitle, and a fixed instrument
   stage in one coherent left column instead of separating the heading far above it.
   Let entry grow into normal page scrolling; do not create inner scrollers in
   its form or device lists. Viewport locking applies only to training.
10. Teach before examining. A new coached lesson explains its vocabulary and
    demonstrates labeled musical comparisons before questions. The learner may
    ask follow-ups, replay concepts, or skip the introduction conversationally.
    Demonstrations never count as scored practice or checkpoint evidence.
    Display their actual notes through the same read-only musical display contract
    used for graded answers. Preserve the piano for pitch, intervals and core
    chord/bass work. Keep Skip in the lower action row as a borderless
    icon/text button with a quiet hover fill, not beside the Tutorial label.
    Finish with a readiness invitation and wait. Only an explicit start_practice
    tool call after agreement or Skip begins exercises. Pitch-direction practice
    and its demonstrations use only rising and falling notes, not unisons.
11. Use one realtime conversation for input, tools, native streamed voice, and
    captions. Natural variations in spoken phrasing are acceptable. Do not add
    a second narrator, verbatim-speech verification, or a speech-delivery gate
    to deterministic scoring. Preserve causal tool/result and playback order.
12. Entry has one action regardless of input hardware. A missing or disabled
    microphone never blocks the course; typing remains available. The in-lesson
    microphone control accurately reflects off, unavailable, and active states.
13. Keep SQLite and PostgreSQL behind the same async execution-storage interface.
    Normal runtime separates browser-persisted guests from Supabase accounts,
    with transient SQL workspaces and encrypted, owner-bound saves. Never seed
    new identities from the historical single-user test database. Grading and
    checkpoints remain atomic; do not duplicate music or agent logic by engine.
14. Keep essential interval practice to two stages after pitch direction:
    randomized ascending/descending pairs, then simultaneous pairs. Use all five
    interval labels without a fixed-root reference or a comparison prelude.
    Teach labeled examples in the introduction, not before every question.
15. Use shadcn/ui and Tailwind utilities with short non-bouncy transitions and
    reduced-motion support. Keep the voice visualizer visible at all times in
    lesson states, with a quiet idle shape; only actual coach
    speech animates it. Music never moves it. Keep tutorial/graded musical diagrams
    and verdict evidence in a separate slot, never replacing the visualizer.
    The agent handles hints and explanations; do not add duplicate guide controls.
16. Group server controllers, services, repositories, and named type contracts
    by role. Keep implementation-only types local and substantial helpers beside
    their owning service. Integrate session connection management and the
    teaching/practice flow instead of duplicating layers. Frontend code and public
    assets live under frontend.
    Controllers live in server/controllers; application composition and common
    middleware stay in server/app.ts and server/middleware.ts beside main.ts.
17. Keep shared limited to public types and validation schemas. The server owns
    curriculum content, settings defaults, musical generation, and checkpoint rules.
    Store AI prompt prose in prompts/\*.j2 and centralize HTTP error handling in errors.
18. Offer only sampled piano and acoustic guitar. Reuse the same polished instrument
    graphics: interactive keys/strings/frets at entry, display-only in the lesson's
    Audio settings popover. Its larger speaker icon sits in the white exercise
    card's upper-right corner and contains the same
    speaker selector and one shared speaker volume control as entry, plus the
    preferred instrument with its Instrument sound selector label. Keep instrument
    preview geometry fixed. Preserve the default 80% level and persist one volume
    for both tutor speech and instrument audio. Previously split-volume saves keep
    their existing volume as the shared speaker level.
19. The message composer has one microphone icon beside the input, opening a listed
    device selector. Speaker devices are also listed, not placed in a dropdown.
    Its fill follows microphone level; muted state uses a crossed
    microphone. Setup and the selector always show a gray or active level meter.
    Do not display Enabled/Disabled text or a separate composer waveform.
    Put one transparent app logo on the first coach message until the next human
    message. Following coach paragraphs align under its text without repeating
    the logo. Remove the pink circular background and keep divider-to-content
    left padding compact. Do not show Earrr text or Interrupted labels.
    Keep input labels accessible
    without displaying filler instructions. The compact latest-message preview
    uses real left/right bubbles with an unclipped visible logo. Consecutive coach
    previews show the latest message instead of clipping an earlier run's logo, with enough room
    above the composer. Preserve user scroll position during streamed replies;
    new input brings the latest message and response indicator fully into view.
    The entire compact conversation preview expands history. Use a double-down
    icon and Minimize to collapse it; do not add a separate History label.
20. Keep the desktop lesson sidebar visible with readable labels, a clearly
    contrasted selected row, and aligned completion/lock icons. Only mobile has
    a top-left hamburger and overlay drawer; do not show a selected-row dot.
    Replace the sidebar progress footer with a playful ear companion. Its title
    reflects completed chapters without XP; clicking triggers silent expressive
    motion, never scores or distracting audio. Everything below Lessons, including
    the full companion and title after the lesson list, shares one native scroll
    container on desktop and in the mobile drawer. Do not pin the companion as a
    fixed footer. Keep the Earrr brand at the drawer's top.
    The app header's right side has a prominent, slightly larger neutral outlined
    Log In pill while signed out, or an outlined first-name/last-name account
    button while signed in. Do not use an initials avatar.
    Align brand and login control within a consistently padded header. Keep the
    sidebar heading Lessons, not Course.
    The training header shows a passive Earrr logo, not Home/Tutorial links. Put the
    tutorial-return action inside the exercise card's upper-left corner, opposite
    the larger speaker control. Give controls and answer marks breathing room
    from card edges on both desktop and mobile.
    Pass condition and ten answer marks belong inside the white exercise card.
    Show Pass condition 8/10 without a duplicate running numeric score. Use vivid,
    accessible green/red marks. Newly filled
    marks fade upward. Mode headings use an understated cube/book icon and text,
    not pill badges. Hear again has a bordered boundary; Skip is a soft text action.
    The final tutorial invitation replaces Skip with Start exercises.
    Hide the main replay control while an answer is revealed. Filled answer
    marks provide hover/touch popovers with saved notes and safe replay.
    Hide Tutorial return during teaching. Returning from practice requires
    Cancel/Confirm before resetting the current round, while all saved history remains.
21. Instrument graphics have no logos, indicator dots, pitch labels or fret numbers.
    The acoustic guitar has a recognizable body, narrow tapered neck, bridge and
    headstock. Low sixth string is at the top, high first string at the bottom.
    Keep the visible Instrument sound selector label.
22. Do not use loading skeletons. Keep the entry controls in place during startup
    and show a spinner instead of the start button's arrow, with a pressed,
    disabled appearance until the session is ready. Errors leave entry retryable.
23. Use thin, softly colored native scrollbars rather than a custom JavaScript
    scrolling system. Keep wheel, touch, and keyboard scrolling behavior intact.
24. Use non-overlapping rounds of up to ten questions with a universal 8/10 rule. Allocate
    fixed counts of question types before shuffling their order; do not use hidden
    diversity gates. End immediately at eight correct answers or three misses. Keep actual answered
    counts and leave unasked positions unfilled; do not fabricate ten answers.
    Both outcomes clear the next tally and wait for explicit start_round consent.
    Keep the final graded musical display, note facts and filled answer marks visible while
    waiting. Use the ordinary grading layout with Round passed / Round not passed
    replacing its heading, not a separate completion screen or Last answer recap.
    Use the same small outlined, rounded button and typography as Hear again for
    Restart exercises. Center it alone or center the group with Next lesson on its right.
    Restart clears old result/evidence immediately, before asynchronous preparation.
    Waiting survives navigation and reconnect. Hints
    remain tracked for mastery, not an additional passing gate.
25. Reveal labeled musical evidence only from committed grading facts, never
    from a model guess or an unanswered question. Clear it before playing a new
    question. Keep it separate from the interactive audition instruments.
    Do not repeat individual verdict labels in the main reveal; the answer,
    highlighted notes, conversation and colored marks already communicate them.
26. Use locally served Instrument Sans for a softer, legible musical interface.
    Compare actual desktop/mobile typography before changing font families.
27. Use Earrr everywhere (three r characters), with original subdued rounded-bar
    icon assets and a whole outlined wordmark image. Maintain light-theme harmony
    and keyboard focus through subtle fills rather than heavy icon focus borders.
28. Keep primary surfaces and controls neutral. Use rose/pink for the logo,
    exercise identifiers and played-note highlights. Tutorial uses yellow/gray,
    distinct from exercise pink; retain green/red for grading correctness.
29. Persist each lesson's exact tutorial/practice position on the server, separately
    for coach and solo modes. Use Zustand as the single frontend state owner,
    with the audio/transport action engine outside reactive state. Navigation,
    reconnect and server restart must not silently convert a reviewed tutorial to practice.
30. Always show audio/microphone setup before entry, regardless of account,
    remembered login or existing learning. Preserve the exact saved lesson behind
    that gate and resume only after Start training. Journal grading before
    sending it so a lost acknowledgement can be retried with the same call ID.
    Never delete invalid or untransferred local progress as a recovery shortcut.
31. Verified signup transfers guest learning once and clears it only after a
    committed cloud save. Normal email/password login loads the existing account
    without overwriting it. Sign out starts a fresh guest; account changes clear
    old captions and revealed answers.
32. Center account UI optically. Login has a form and a Don't have an account?
    title, progress subtitle and create-account action, without New here.
    Create an account uses the same text-link treatment, size and brand color
    as Forgot password. Verification copy says Enter the code sent to, without
    specifying six digits.
    Signup is a centered single-column form, with no right-hand progress panel
    or Already have an account / Log In promotion. It asks first name, last
    name, email and password; email-code verification automatically signs in.
    Recovery uses an email code. Google remains hidden until its provider is enabled.
33. Use the authentication SDK's persisted sessions and refresh logic. Resolve
    account identity on the server and enforce private cloud writes, own-row
    reads and optimistic revisions. Never send server keys to the browser.
34. Coach as a precise teacher: concise musical explanations and concrete
    feedback, without filler promises, flattery or repeated readiness invitations.
    Never pronounce the app name, which belongs to visual branding.
35. Include section 00 Welcome before new coached learning. Its visible title is
    Welcome. Briefly introduce the AI coach and the range from basic pitch/intervals
    to advanced chords/harmony, then ask to start ear training and wait for agreement.
    Do not ask to start pitch direction or recite the app name. Welcome is
    unscored, never unlocks musical lessons or contributes to mastery, and preserves
    the exact parked lesson/round when revisited. Keep the existing explicit
    tutorial-to-exercise and completed-round/next-lesson choices.
36. After explicit audio setup, enter the saved section with one connection attempt.
    A disconnection, unreachable server, fatal API error or unexpected client error
    stops audio/actions and blocks the app with a light full-screen blur and a
    compact Something went wrong toast containing Refresh. Refresh reloads the page;
    do not silently reconnect, retry expired guest capabilities, or resume on online
    events. Preserve the mutation journal for reload recovery. Routine invalid
    answers, form validation and microphone/speaker permission notices remain local
    and nonfatal. Intentional pause/end does not trigger a failure overlay.
37. Keep the browser tab title fixed to Earrr | Ear training game with a friendly
    AI tutor. for every surface, including account screens.
38. Tutorial dots are an ungated step selector, not mastery or a completion
    percentage. Show current explanation position or tutorial-end state, with
    subtle played/unplayed colors based only on valid delivery facts. Every dot
    stays freely clickable/touchable and replays that explanation. Save indications
    per lesson/mode without affecting scores or prerequisites. Use only a restrained
    reduced-motion-safe opacity fade for tutorial/practice transitions. Show a
    pointer cursor and an app-native hover/keyboard-focus tooltip, never a browser
    title tooltip.
    A selected explanation automatically continues through the following steps
    after valid speech/music delivery, stopping at the explicit practice invitation.
    Show the actual semitone distance under interval tutorial notes, including
    ascending/descending pairs. Avoid repeat comparisons and re-teaching prerequisite
    vocabulary; retain every new concept. Persist positions by stable step ID,
    with compatible restoration of older numeric positions.
39. Do not re-enable custom SMTP or reuse the retired sender/domain for this
    setup. The user owns provider settings. Keep email-delivery errors honest and
    do not treat generated test codes as proof that an inbox received email.
40. Save canonical chat with its guest/account learning archive and restore the
    owner's recent conversation on entry, including across training sessions.
    Keep complete history in storage and a bounded recent UI/model window.
    Historical dialogue is read-only context, never consent or pending actions.
    Keep checkpoint messages separate from chat; identity changes clear old-owner UI.
41. Resolve account-button first and last names from the user's own authoritative
    profile, even when remembered session metadata is stale or empty. Preserve
    resolved names through token refresh, never guess them from an email, and
    report profile-loading errors explicitly.
42. Render the full audio setup intro immediately. Hydrate identity, profile,
    learning and curriculum in the background, without a preceding loading page
    or lazy intro placeholder. Server-owned initial instrument/volume are only
    presentation defaults, never fabricated learning. An early Start training
    click unlocks audio immediately and waits for remaining initialization inside
    that button's spinner. Preserve preparation errors and owner cancellation.
43. Put the lesson's musical display above the voice visualizer. The intro has no coach
    visualizer; retain its microphone level meter. Use the same Instrument sound
    label and selector typography in intro and in-game Audio settings.
    Keep the in-game visualizer visible and independent of music playback.
    During Hear again, keep Your turn unchanged and show a small, local,
    reduced-motion-safe speaker indicator, including answer-review popups.
44. Bound native Realtime context with retention-ratio truncation and a lower
    conversation-token budget. Keep recent literal messages and authoritative
    musical state. Separate summary calls are not needed for cost control;
    optional summarizer credentials remain private server configuration.
45. Resolve conversational navigation from exact visible lesson names. A locked
    requested lesson stays blocked until its prerequisite exercise checkpoint
    passes; clearly name that prerequisite and 8/10 target. Never substitute the
    current lesson or claim the requested target is already active.
46. On secure app entry, request microphone permission immediately if the browser
    still needs consent, before backend hydration or a device-selection click.
    Stop the short authorization stream and preserve mic-off/saved preferences.
    Already granted permission needs no capture; denied or pending permission
    does not add an entry flow or trigger automatic retries after entry. Opening
    in-game microphone settings explicitly rechecks/retries missing access;
    browser-blocked permission is explained there if Chrome cannot show a new prompt.
    Both surfaces offer None or enumerated explicit inputs, never a System
    microphone/default/communications alias. Speaker selection does not request
    microphone access; use a browser-native speaker chooser only if the browser
    supports it and actually denies a requested output device.
47. Welcome and the first three pitch/interval lessons retain their musical
    content and piano presentation. Chromatic intervals and standalone reference
    pitch are retired from the active course. Use small, explicit answer sets
    after major/minor, usually two to four and never more than five new categories.
    Inversion questions supply the chord quality so the learner judges only the
    bass position. Root naming uses C4 and five nearby roots in the same octave.
48. Use 29 short lessons across nine chapters: pitch/intervals; chord colors;
    scales/modes; roots/triad inversions; seventh chords; progressions; seventh
    inversions; added tones/extensions; altered dominants. Introduce major/minor,
    then diminished/augmented, then sus4 (five qualities total). Minor scales cover
    natural, harmonic and ascending melodic minor only. Split major-family and
    minor-family modes; omit pentatonic, blues, whole tone and melodic recall.
    Seventh colors exclude minor-major seventh. Added ninths precede sixths,
    ninths, minor elevenths and thirteenths; altered ninths, fifths and upper
    alterations have separate two-choice lessons.
51. Teach harmonic functions I/IV/V and ii/iii/vi before progression questions.
    Introduce ii-V-I first, then a few short related paths. Every progression
    supplies its beginning and ending; grade one or two missing inner functions,
    never demand whole-sequence recall. Both single and complete spoken replies
    can supply the requested missing positions. Speak all given clues.
52. Scripted speech is scoped to the current presentation, not the complete
    conversation. Teaching receives one explanation, without redundant visual
    titles or labels; timing, silence and playback are application behavior, not
    narration. Navigation invalidates old presentation epochs while allowing
    already-committed grading to finish. Stale results cannot repaint the selected
    lesson or narrate the previous exercise.
53. The major/minor introduction has five steps. Its fourth step compares the
    character of CM, Cm, EM and Em, each with its own explanation, audio and
    changing piano. Mood is a useful listening clue, not a universal emotion rule.
    Delivery advances examples inside that step before continuing to the final
    practice invitation. Save and replay the actual example position.
54. Use clean piano diagrams and prominent conventional symbols such as CM, Cm,
    C7, C7b5 and Cadd9 for chords. Use VexFlow SVG engraving with locally bundled
    Bravura for scales and progression notation, never approximate note-dot charts.
    Unknown positions contain no pitch data. Use a single clef for scalar lines
    and a grand staff only when chord voicings need it. Short screens may use a
    compact symbol strip; full notation remains available in answer review.
    Keep graphics inside their slot, above the independent voice visualizer.
    Never draw an empty staff for an unknown-only question. A single unknown
    harmonic function uses a centered tonic-reference/answer prompt; notation is
    reserved for actual supplied or revealed pitches.
55. Curriculum revision changes preserve recorded attempts and genuine completion.
    Retired selections are mapped to active lessons; incompatible pending rounds
    and tutorial positions are reintroduced rather than misgraded with new rules.
    New lessons are not automatically marked complete. Companion rank milestones
    scale with the number of active chapters and reserve the final rank for all.
56. Use a single Supabase raw-event table for traffic, usage and reliability
    analytics instead of Google Analytics. Keep essential dimensions in columns
    and event-specific data in a JSON message. Client/server code shares the
    Log.event(name, message, options) interface; attach only session, request,
    verified actor and environment context. Use descriptive snake_case event names,
    such as user_start_training. Keep one app-open event per restored page visit,
    actual training starts, lesson/exercise-round choices, committed answer/round
    outcomes, successful signup/login and major failures. These support active-user,
    retention and learning-funnel statistics without request, playback, device,
    speech or visibility traces. Do not store source, visit, visitor or release
    dimensions, raw chat, microphone audio, credentials or direct identifiers.
    Only server-side service credentials can access the table.
57. Logs have 30-day retention based on server receipt time, with an hourly purge.
    This does not delete learning or conversation history. Keep logging small,
    bounded and best-effort; delivery failure is explicit in diagnostic output but
    must not block the app or recursively log itself. Do not add materialized
    analytics tables, aggregation pipelines or a persistent client log cache.
58. Serve a real robots.txt and a canonical-homepage sitemap. Keep the public title
    unchanged, include consistent canonical/social metadata and WebSite structured
    data, and return genuine 404s for nonexistent URLs. Preserve the OAuth callback
    and mark authentication/API responses noindex without blocking resources needed
    to render the app. Cache fingerprinted build assets immutably. Do not invent
    reviews, ratings or private lesson URLs for search engines.

## Ear-training design references

The course uses narrow contrast sets, tonal references and increasingly contextual
harmonic listening rather than reproducing a semester-long dictation syllabus.
Reference and endpoint clues reduce working-memory load while keeping the missing
sound an aural judgment. Instruction precedes each newly tested distinction.

- [Baylor, The Ear Training Compendium, harmonic dictation foundations](https://openbooks.library.baylor.edu/eartraining/chapter/unit-2-harmonic-dictation/): introduce tonal function through a small set of familiar root-position chords.
- [TEORIA, chord dictation](https://www.teoria.com/en/exercises/ce.php) and [harmonic dictation](https://www.teoria.com/en/exercises/hp.php): isolate selectable chord families and provide key/reference support.
- [Berklee, Harmonic Ear Training](https://online.berklee.edu/courses/harmonic-ear-training-recognizing-chord-progressions): connect chord vocabulary, tonal function and familiar progressions before advanced harmonic movement.
- [VexFlow 5 engraving tutorial](https://vexflow.github.io/vexflow-examples/guides/tutorial/): use real staves, noteheads and accidentals instead of hand-drawn approximations.

## Accessibility & Inclusion

Target WCAG AA contrast and keyboard access. Provide visible focus, reduced-motion
support, understandable status text, and a typed conversational alternative.
Never encode feedback using color alone. Use English initially. Show microphone
consent clearly and make muting and ending a session immediately accessible.
Explain desktop background behavior and operating-system sleep limitations
without making guarantees the browser cannot keep.
