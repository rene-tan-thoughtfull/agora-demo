import { Router, Request, Response } from "express";
import axios from "axios";
import { startSttTask, querySttTask, stopSttTask } from "../services/agora-stt";

const router = Router();

// channelName → agentId; prevents duplicate bots when multiple clients call /start concurrently
const activeSessions = new Map<string, string>();

function handleError(err: unknown, res: Response) {
  if (axios.isAxiosError(err)) {
    res.status(err.response?.status ?? 502).json({
      error: err.message,
      details: err.response?.data,
    });
  } else {
    res.status(500).json({ error: String(err) });
  }
}

// POST /stt/start
router.post("/start", async (req: Request, res: Response) => {
  const { channelName, pubBotUid, pubBotToken, languages, translateLanguages } = req.body;

  if (!channelName || !pubBotUid || !languages?.length) {
    res.status(400).json({ error: "channelName, pubBotUid, and languages are required" });
    return;
  }

  const existingAgentId = activeSessions.get(channelName);
  if (existingAgentId) {
    res.json({ agentId: existingAgentId });
    return;
  }

  try {
    const agent = await startSttTask({ channelName, pubBotUid, pubBotToken, languages, translateLanguages });
    activeSessions.set(channelName, agent.agentId);
    res.json(agent);
  } catch (err) {
    handleError(err, res);
  }
});

// GET /stt/status/:agentId
router.get<{ agentId: string }>("/status/:agentId", async (req, res) => {
  const { agentId } = req.params;

  try {
    const status = await querySttTask(agentId);
    res.json(status);
  } catch (err) {
    handleError(err, res);
  }
});

// POST /stt/stop/:agentId
router.post<{ agentId: string }>("/stop/:agentId", async (req, res) => {
  const { agentId } = req.params;

  try {
    await stopSttTask(agentId);
    for (const [channel, id] of activeSessions) {
      if (id === agentId) { activeSessions.delete(channel); break; }
    }
    res.json({ success: true });
  } catch (err) {
    handleError(err, res);
  }
});

export default router;
