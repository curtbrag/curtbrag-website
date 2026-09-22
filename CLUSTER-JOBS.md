# Curt Cluster distributed jobs

The dashboard at `https://curtbrag.com/cluster/dashboard/` includes a **Jobs** tab.

## Workloads

Health audit, file inventory, SHA-256 checksums, archive creation, incremental rsync backup, yt-dlp download, ffprobe inspection, ffmpeg conversion, and Whisper transcription.

Jobs expand into one task per selected node. Agents claim only their own task, maintain a five-minute lease, and return progress, output, or a failure. Failed and cancelled jobs can be retried.

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
