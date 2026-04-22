# Agora Demo

Cross-platform video calling app with real-time speech-to-text captions, built on [Agora](https://www.agora.io/).

## Packages

| Package | Description |
|---------|-------------|
| [`tf-agora-app`](tf-agora-app/) | Expo React Native app (iOS, Android, Web) |
| [`tf-agora-stt-server`](tf-agora-stt-server/) | Express proxy for Agora's STT REST API |

## Architecture

```
[tf-agora-app]  ──── joins channel ────▶  [Agora RTC Cloud]
      │                                          │
      │  POST /stt/start                         │ protobuf stream messages
      ▼                                          │
[tf-agora-stt-server]                            │
      │  calls Agora STT API                     │
      ▼                                          ▼
[Agora STT Agent]  ── joins channel ──▶  [tf-agora-app]
                                          parses protobuf → live captions
```

The app joins an Agora RTC channel for video. When captions are enabled, the backend starts an Agora STT agent that joins the same channel, transcribes audio, and sends protobuf messages back through the RTC stream — which the app parses and renders as live captions.

## Setup

### 1. Agora credentials

You'll need an [Agora account](https://console.agora.io/) with:
- An App ID
- RESTful API Customer ID + Secret (for STT)

### 2. STT server

```bash
cd tf-agora-stt-server
cp .env.example .env.local   # or create manually
npm install
npm run dev
```

`.env.local`:
```
PORT=3000
AGORA_APP_ID=your_app_id
AGORA_CUSTOMER_ID=your_customer_id
AGORA_CUSTOMER_SECRET=your_customer_secret
```

### 3. App

```bash
cd tf-agora-app
cp .env.example .env.local   # or create manually
npm install
npm start
```

`.env.local`:
```
EXPO_PUBLIC_AGORA_APP_ID=your_app_id
EXPO_PUBLIC_STT_SERVER_URL=http://<stt_server_ip>:3000
```

Then choose a platform from the Expo dev menu (`i` for iOS, `a` for Android, `w` for web).

## STT Server API

| Method | Route | Description |
|--------|-------|-------------|
| `POST` | `/stt/start` | Start a transcription session |
| `GET` | `/stt/status/:agentId` | Query agent status |
| `POST` | `/stt/stop/:agentId` | Stop a transcription session |
| `GET` | `/health` | Health check |

**Start request body:**
```json
{
  "channelName": "my-channel",
  "pubBotUid": "0",
  "pubBotToken": "optional",
  "languages": ["en-US"],
  "translateLanguages": ["es-ES"]
}
```
