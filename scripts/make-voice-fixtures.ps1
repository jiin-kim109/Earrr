$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$directory = Join-Path (Get-Location) 'test-results'
New-Item -ItemType Directory -Path $directory -Force | Out-Null
$phrases = @{
    'voice-skip-intro.wav' = 'Skip.'
    'voice-replay.wav' = 'Hey, I did not hear that. Could you play that one again, please?'
    'voice-answer.wav' = 'I think the second note went up.'
    'voice-pause.wav' = 'Hold on a moment. I need to pause the practice.'
    'voice-resume.wav' = 'I am ready now. Let us carry on.'
    'voice-stop.wav' = 'That is enough practice for now. Please end this session.'
}
foreach ($entry in $phrases.GetEnumerator()) {
    $speech = New-Object System.Speech.Synthesis.SpeechSynthesizer
    try {
        $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(24000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
        $speech.SetOutputToWaveFile((Join-Path $directory $entry.Key), $format)
        $speech.Speak($entry.Value)
    }
    finally {
        $speech.Dispose()
    }
}
Write-Output 'Generated original synthetic speech fixtures. No real microphone was accessed.'
