import axios from "axios";

const AGORA_BASE_URL = "https://api.agora.io";

function getAuthHeader(): string {
  const credentials = `${process.env.AGORA_CUSTOMER_ID}:${process.env.AGORA_CUSTOMER_SECRET}`;
  return `Basic ${Buffer.from(credentials).toString("base64")}`;
}

function projectUrl(path: string): string {
  const appId = process.env.AGORA_APP_ID!;
  return `${AGORA_BASE_URL}/api/speech-to-text/v1/projects/${appId}${path}`;
}

export interface StartSttParams {
  channelName: string;
  pubBotUid: string;
  pubBotToken?: string;
  languages: string[];
  translateLanguages?: string[];
}

export interface SttAgent {
  agentId: string;
  status: string;
}

export async function startSttTask(params: StartSttParams): Promise<SttAgent> {
  const body: Record<string, unknown> = {
    name: `stt-${params.channelName}-${Date.now()}`,
    languages: params.languages,
    rtcConfig: {
      channelName: params.channelName,
      pubBotUid: params.pubBotUid,
      ...(params.pubBotToken ? { pubBotToken: params.pubBotToken } : {}),
    },
    ...(params.translateLanguages?.length
      ? {
          translateConfig: {
            languages: params.languages.map((src) => ({
              source: src,
              target: params.translateLanguages!,
            })),
          },
        }
      : {}),
  };

  const res = await axios.post(projectUrl("/join"), body, {
    headers: {
      Authorization: getAuthHeader(),
      "Content-Type": "application/json",
    },
  });

  return { agentId: res.data.agent_id as string, status: res.data.status as string };
}

export async function querySttTask(agentId: string): Promise<unknown> {
  const res = await axios.get(projectUrl(`/agents/${agentId}`), {
    headers: { Authorization: getAuthHeader() },
  });
  return res.data;
}

export async function stopSttTask(agentId: string): Promise<void> {
  await axios.post(projectUrl(`/agents/${agentId}/leave`), null, {
    headers: { Authorization: getAuthHeader() },
  });
}
