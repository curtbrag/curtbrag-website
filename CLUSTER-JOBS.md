# Curt Cluster distributed jobs

The dashboard at `https://curtbrag.com/cluster/dashboard/` includes a **Jobs** tab.

## Workloads

Health audit, file inventory, SHA-256 checksums, archive creation, incremental rsync backup, yt-dlp download, ffprobe inspection, ffmpeg conversion, and Whisper transcription.

Jobs expand into one task per selected node. Agents claim only their own task, maintain a five-minute lease, and return progress, output, or a failure. Failed and cancelled jobs can be retried.

The separate Swarm and hybrid workers now default to a 60-second poll to limit hosted API requests. The command bridge polls every 30 seconds when idle and refreshes fleet state every 90 seconds. A queued command may take about a minute to start. Already running agents keep their previous intervals until restarted or redeployed; installed environment overrides such as `POLL_INTERVAL` and `CLUSTER_JOB_POLL` still take precedence.

## Install agents

Termux/Linux/Steam Deck:

```sh
curl -fsSL https://raw.githubusercontent.com/curtbrag/curtbrag-website/main/scripts/install-cluster-job-agent.sh | sh -s -- phone173
```

Use each node's canonical name. The installer reuses `CLUSTER_API_KEY` from `~/.cluster-env` when available.

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/curtbrag/curtbrag-website/main/scripts/install-cluster-job-agent.ps1 -OutFile $env:TEMP\install-cluster-job-agent.ps1
& $env:TEMP\install-cluster-job-agent.ps1 -Node Alina
```

The agent accepts only an allowlist of workloads; it does not expose arbitrary remote shell execution. Root paths are rejected, results are size-limited, and every operation requires authentication.

## Local RenderRig transcription

From a checked-out copy of this repository, prepare the isolated transcription environment and the selected model once:

```powershell
& scripts/setup-transcription.ps1 -Model small.en
```

This installs faster-whisper 1.2.1 in `%LOCALAPPDATA%\CurtCompute\transcription-venv`, caches the selected model, and installs the worker expected by the existing `whisper-transcribe` job. It uses CPU INT8 inference; it does not require GPU drivers or a paid transcription API. Model downloads happen during setup. Jobs require the prepared local model and do not download models.

Choose **Transcribe on RenderRig** in the dashboard, supply an existing local input file, and choose a fresh output directory. For example:

```json
{"input":"C:\\Jobs\\sample.mp4","output":"C:\\Jobs\\transcripts\\sample-run-1","model":"small.en"}
```

The result includes transcript text and paths for UTF-8 text, structured JSON with segment timing, and SRT subtitles. Existing transcript files are preserved; use a new output directory to rerun the same source.
