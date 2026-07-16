# Colab Sync Control

Colab Sync Control is a professional VS Code extension that provides a visual dashboard, sidebar interface, and status bar telemetry to manage and synchronize your local workspace folders with Google Colab runtimes.

## Features

- **Interactive Local Shell**: Open zero-lag interactive terminals directly inside VS Code or launch external window shells (e.g. Kitty terminal emulator) connected to the remote Colab runtime.
- **Bi-directional Sync Monitoring**: Track incoming/outgoing changes and conflicts directly inside the dashboard and VS Code's bottom status bar.
- **Resource Utilization Panel**: Real-time progress indicators showing CPU, System RAM, Disk space, and GPU VRAM allocations (supporting T4/L4/A100/TPU).
- **Compute Unit Quota Tracker**: View hourly consumption rates and remaining free/paid compute units balance in real time.
- **Vibrant Custom Themes**: Choose between curated minimal design systems, deep space tech backdrops, or animated Neo-Retro Cyberpunk themes.

## Getting Started

### 1. Prerequisites

Make sure the `colabd` daemon is running on your system. You can install it from the core repository and start it directly via the VS Code Command Palette:

```bash
node /path/to/colab-sync/src/colabd.js --workspace /path/to/your/workspace
```

### 2. Usage

1. Open the **Colab Sync** sidebar panel in the VS Code Activity Bar.
2. Click **Open Web UI Dashboard** to view live metrics and change themes.
3. Link your workspace folder to the active daemon configuration.
4. Claim a remote Colab session (Standard CPU, T4/L4/A100 GPU, or TPU).
5. Open the interactive terminal session to stream commands remotely with zero typing latency.

## Extension Commands

| Command | Description |
| --- | --- |
| `Colab Sync: Start Daemon` | Starts the local `colabd` background server on port `8291`. |
| `Colab Sync: Stop Daemon` | Terminates the background daemon server processes. |
| `Colab Sync: Link Workspace` | Links the current workspace folder to a registered path. |
| `Colab Sync: Open Dashboard` | Displays the graphical control panel webview. |
| `Colab Sync: Open Colab Terminal` | Spawns the zero-lag interactive shell inside VS Code. |
| `Colab Sync: Force Sync` | Executes a bi-directional file synchronization pass. |
| `Colab Sync: Kill Session` | Terminates the active Google Colab cloud runtime. |

## License

This project is licensed under the [MIT License](LICENSE).
