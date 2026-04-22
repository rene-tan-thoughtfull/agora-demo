import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  PermissionsAndroid,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useColorScheme,
  View,
} from 'react-native';
import {
  ChannelProfileType,
  ClientRoleType,
  createAgoraRtcEngine,
  FrameRate,
  IRtcEngine,
  IRtcEngineEventHandler,
  OrientationMode,
  RtcSurfaceView,
  VideoMirrorModeType,
} from 'react-native-agora';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Colors, Spacing } from '@/constants/theme';

const AGORA_APP_ID = process.env.EXPO_PUBLIC_AGORA_APP_ID ?? '';
// const STT_SERVER_URL = process.env.EXPO_PUBLIC_STT_SERVER_URL ?? 'http://localhost:3000';
const STT_SERVER_URL = "http://192.168.1.195:3000";

async function requestAndroidPermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  const results = await PermissionsAndroid.requestMultiple([
    PermissionsAndroid.PERMISSIONS.CAMERA,
    PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
  ]);
  return (
    results[PermissionsAndroid.PERMISSIONS.CAMERA] === PermissionsAndroid.RESULTS.GRANTED &&
    results[PermissionsAndroid.PERMISSIONS.RECORD_AUDIO] === PermissionsAndroid.RESULTS.GRANTED
  );
}

interface SttSession {
  agentId: string;
}

interface SttMessage {
  uid: number;
  time: number;
  words: { text: string; isFinal: boolean }[];
}

// Agora STT agent sends stream messages as protobuf (TranscriptMessage schema).
// Wire types: 0=varint, 1=64-bit, 2=length-delimited, 5=32-bit
function readVarint(data: Uint8Array, pos: number): [number, number] {
  let result = 0;
  let shift = 0;
  while (pos < data.length) {
    const b = data[pos++];
    result += (b & 0x7f) * Math.pow(2, shift); // avoids 32-bit bitwise overflow
    shift += 7;
    if ((b & 0x80) === 0) break;
  }
  return [result, pos];
}

function parseWord(data: Uint8Array): { text: string; isFinal: boolean } {
  let pos = 0;
  let text = '';
  let isFinal = false;
  while (pos < data.length) {
    const [tag, p1] = readVarint(data, pos);
    pos = p1;
    const field = tag >> 3;
    const wire = tag & 0x7;
    if (wire === 0) {
      const [val, p2] = readVarint(data, pos);
      pos = p2;
      if (field === 4) isFinal = val !== 0;
    } else if (wire === 2) {
      const [len, p2] = readVarint(data, pos);
      pos = p2;
      const bytes = data.subarray(pos, pos + len);
      pos += len;
      if (field === 1) text = new TextDecoder().decode(bytes);
    } else if (wire === 5) {
      pos += 4;
    } else if (wire === 1) {
      pos += 8;
    }
  }
  return { text, isFinal };
}

function parseSttMessage(data: Uint8Array): SttMessage | null {
  try {
    let pos = 0;
    let uid = 0;
    let time = 0;
    const words: { text: string; isFinal: boolean }[] = [];
    while (pos < data.length) {
      const [tag, p1] = readVarint(data, pos);
      pos = p1;
      const field = tag >> 3;
      const wire = tag & 0x7;
      if (wire === 0) {
        const [val, p2] = readVarint(data, pos);
        pos = p2;
        if (field === 4) uid = val;
        else if (field === 6) time = val;
      } else if (wire === 2) {
        const [len, p2] = readVarint(data, pos);
        pos = p2;
        const bytes = data.subarray(pos, pos + len);
        pos += len;
        if (field === 10) words.push(parseWord(bytes));
      } else if (wire === 5) {
        pos += 4;
      } else if (wire === 1) {
        pos += 8;
      }
    }
    return { uid, time, words };
  } catch {
    return null;
  }
}

export default function VideoCallScreen() {
  const engineRef = useRef<IRtcEngine | null>(null);
  const sttRef = useRef<SttSession | null>(null);
  const colorScheme = useColorScheme();
  const colors = Colors[colorScheme === 'dark' ? 'dark' : 'light'];

  const [channel, setChannel] = useState('my');
  const [token, setToken] = useState('007eJxTYMi7va/v1qu+8s2SkhvjZR26lA59fCh5w3L5xsmF+7czX1ipwJCSZpGcapZsbGlhbm5iZGxmmWxhaWyabGyQmJSWapJq5mb9IrMhkJFBpPkiMyMDBIL4TAy5lQwMAJ2VIFI=');
  const [uid, setUid] = useState('0');

  const [isJoined, setIsJoined] = useState(false);
  const [remoteUids, setRemoteUids] = useState<number[]>([]);
  const [isMuted, setIsMuted] = useState(false);
  const [isCameraOff, setIsCameraOff] = useState(false);
  const [finalCaption, setFinalCaption] = useState('');
  const [interimCaption, setInterimCaption] = useState('');
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
      stopStt();
      engineRef.current?.leaveChannel();
      engineRef.current?.release();
      engineRef.current = null;
    };
  }, []);

  async function startStt(channelName: string, pubBotUid: string, pubBotToken?: string) {
    try {
      console.info('Starting STT session with', { channelName, pubBotUid, pubBotToken, });
      const res = await fetch(`${STT_SERVER_URL}/stt/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channelName,
          pubBotUid,
          ...(pubBotToken ? { pubBotToken } : {}),
          languages: ['en-US'],
        }),
      });
      if (!res.ok) throw new Error(`STT start failed: ${res.status}`);
      const data = await res.json() as SttSession;
      sttRef.current = data;
    } catch (e) {
      console.warn('STT start error:', e);
    }
  }

  async function stopStt() {
    const session = sttRef.current;
    if (!session) return;
    sttRef.current = null;
    try {
      await fetch(`${STT_SERVER_URL}/stt/stop/${session.agentId}`, { method: 'POST' });
    } catch (e) {
      console.warn('STT stop error:', e);
    }
  }

  async function joinCall() {
    if (!AGORA_APP_ID) {
      Alert.alert('Missing config', 'Set EXPO_PUBLIC_AGORA_APP_ID in .env.local and rebuild.');
      return;
    }
    if (!channel.trim()) {
      Alert.alert('Missing fields', 'Channel Name is required.');
      return;
    }
    const permitted = await requestAndroidPermissions();
    if (!permitted) {
      Alert.alert('Permissions denied', 'Camera and microphone access is required.');
      return;
    }

    const engine = createAgoraRtcEngine();
    engine.initialize({
      appId: AGORA_APP_ID,
      channelProfile: ChannelProfileType.ChannelProfileCommunication,
    });

    const handler: IRtcEngineEventHandler = {
      onJoinChannelSuccess: () => {
        setIsJoined(true);
        startStt(channel.trim(), '999', token.trim() || undefined);
      },
      onUserJoined: (_conn, remoteUid) => setRemoteUids(prev => [...prev, remoteUid]),
      onUserOffline: (_conn, remoteUid) =>
        setRemoteUids(prev => prev.filter(u => u !== remoteUid)),
      onStreamMessage: (_conn, _remoteUid, _streamId, data) => {
        console.info('Received STT raw bytes:', data)
        const msg = parseSttMessage(data);
        console.info('Received STT message: ', msg)
        if (!msg) return;
        const finals = msg.words.filter(w => w.isFinal).map(w => w.text).join(' ').trim();
        const interim = msg.words.filter(w => !w.isFinal).map(w => w.text).join(' ').trim();
        if (finals) {
          setFinalCaption(prev => `${prev} ${finals}`.trim().slice(-300));
          setInterimCaption('');
        }
        if (interim) setInterimCaption(interim);
        if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
        clearTimerRef.current = setTimeout(() => {
          setFinalCaption('');
          setInterimCaption('');
        }, 5000);
      },
      onError: (err, msg) => Alert.alert('Agora Error', `[${err}] ${msg}`),
    };

    engine.registerEventHandler(handler);
    engine.enableVideo();
    engine.setVideoEncoderConfiguration({
      dimensions: { width: 1280, height: 720 },
      frameRate: FrameRate.FrameRateFps30,
      bitrate: 0,
      orientationMode: OrientationMode.OrientationModeAdaptive,
      mirrorMode: VideoMirrorModeType.VideoMirrorModeAuto,
    });
    engine.startPreview();
    engine.joinChannel(token.trim() || '', channel.trim(), parseInt(uid) || 0, {
      clientRoleType: ClientRoleType.ClientRoleBroadcaster,
      publishCameraTrack: true,
      publishMicrophoneTrack: true,
    });

    engineRef.current = engine;
  }

  async function leaveCall() {
    await stopStt();
    engineRef.current?.leaveChannel();
    engineRef.current?.stopPreview();
    engineRef.current?.release();
    engineRef.current = null;
    setIsJoined(false);
    setRemoteUids([]);
    setIsMuted(false);
    setIsCameraOff(false);
    setFinalCaption('');
    setInterimCaption('');
    if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
  }

  function toggleMute() {
    engineRef.current?.muteLocalAudioStream(!isMuted);
    setIsMuted(v => !v);
  }

  function toggleCamera() {
    engineRef.current?.muteLocalVideoStream(!isCameraOff);
    setIsCameraOff(v => !v);
  }

  if (isJoined) {
    return (
      <View style={styles.callRoot}>
        {remoteUids.length > 0 ? (
          <RtcSurfaceView style={styles.remoteVideo} canvas={{ uid: remoteUids[0] }} />
        ) : (
          <View style={styles.waitingView}>
            <Text style={styles.waitingText}>Waiting for participants...</Text>
          </View>
        )}

        <RtcSurfaceView
          style={styles.localVideo}
          canvas={{ uid: 0 }}
          zOrderMediaOverlay
        />

        <View style={styles.bottomOverlay}>
          {(finalCaption.length > 0 || interimCaption.length > 0) && (
            <View style={styles.captionContainer}>
              {finalCaption.length > 0 && (
                <Text style={styles.captionText}>{finalCaption}</Text>
              )}
              {interimCaption.length > 0 && (
                <Text style={[styles.captionText, styles.captionInterim]}>{interimCaption}</Text>
              )}
            </View>
          )}

          <SafeAreaView edges={['bottom']} style={styles.controlsBar}>
            <Pressable
              style={[styles.ctrlBtn, isMuted && styles.ctrlBtnActive]}
              onPress={toggleMute}>
              <Text style={styles.ctrlLabel}>{isMuted ? 'Unmute' : 'Mute'}</Text>
            </Pressable>
            <Pressable style={[styles.ctrlBtn, styles.endBtn]} onPress={leaveCall}>
              <Text style={[styles.ctrlLabel, styles.endLabel]}>End</Text>
            </Pressable>
            <Pressable
              style={[styles.ctrlBtn, isCameraOff && styles.ctrlBtnActive]}
              onPress={toggleCamera}>
              <Text style={styles.ctrlLabel}>{isCameraOff ? 'Cam On' : 'Cam Off'}</Text>
            </Pressable>
          </SafeAreaView>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.setupRoot, { backgroundColor: colors.background }]}>
      <SafeAreaView style={styles.setupSafe}>
        <ScrollView
          contentContainerStyle={styles.setupContent}
          keyboardShouldPersistTaps="handled">
          <Text style={[styles.heading, { color: colors.text }]}>Video Call</Text>

          <View style={[styles.form, { backgroundColor: colors.backgroundElement }]}>
            <Text style={[styles.label, { color: colors.textSecondary }]}>Channel Name *</Text>
            <TextInput
              style={[styles.input, { color: colors.text, borderColor: colors.backgroundSelected }]}
              placeholder="e.g. test-channel"
              placeholderTextColor={colors.textSecondary}
              value={channel}
              onChangeText={setChannel}
              autoCapitalize="none"
              autoCorrect={false}
            />

            <Text style={[styles.label, { color: colors.textSecondary }]}>Token</Text>
            <TextInput
              style={[styles.input, { color: colors.text, borderColor: colors.backgroundSelected }]}
              placeholder="Leave blank for testing mode"
              placeholderTextColor={colors.textSecondary}
              value={token}
              onChangeText={setToken}
              autoCapitalize="none"
              autoCorrect={false}
            />

            <Text style={[styles.label, { color: colors.textSecondary }]}>UID</Text>
            <TextInput
              style={[styles.input, { color: colors.text, borderColor: colors.backgroundSelected }]}
              placeholder="0 (auto-assigned)"
              placeholderTextColor={colors.textSecondary}
              value={uid}
              onChangeText={setUid}
              keyboardType="number-pad"
            />
          </View>

          <Pressable style={styles.joinBtn} onPress={joinCall}>
            <Text style={styles.joinBtnText}>Join Channel</Text>
          </Pressable>
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  setupRoot: { flex: 1 },
  setupSafe: { flex: 1 },
  setupContent: {
    padding: Spacing.four,
    gap: Spacing.three,
    flexGrow: 1,
  },
  heading: {
    fontSize: 28,
    fontWeight: '700',
    marginBottom: Spacing.one,
  },
  form: {
    borderRadius: Spacing.three,
    padding: Spacing.three,
    gap: Spacing.two,
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    marginTop: Spacing.one,
  },
  input: {
    borderWidth: 1,
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.two,
    fontSize: 15,
  },
  joinBtn: {
    backgroundColor: '#208AEF',
    borderRadius: Spacing.three,
    paddingVertical: Spacing.three,
    alignItems: 'center',
    marginTop: Spacing.one,
  },
  joinBtnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },

  callRoot: { flex: 1, backgroundColor: '#000' },
  remoteVideo: { flex: 1 },
  waitingView: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  waitingText: {
    color: '#fff',
    fontSize: 18,
  },
  localVideo: {
    position: 'absolute',
    top: 60,
    right: 16,
    width: 100,
    height: 150,
    borderRadius: 8,
  },
  bottomOverlay: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
  },
  captionContainer: {
    marginHorizontal: 16,
    marginBottom: 8,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  captionText: {
    color: '#fff',
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 22,
  },
  captionInterim: {
    color: 'rgba(255,255,255,0.6)',
    fontStyle: 'italic',
  },
  controlsBar: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: Spacing.four,
    paddingTop: Spacing.three,
    paddingBottom: Spacing.three,
    paddingHorizontal: Spacing.four,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  ctrlBtn: {
    width: 72,
    height: 48,
    borderRadius: 24,
    backgroundColor: 'rgba(255,255,255,0.2)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  ctrlBtnActive: {
    backgroundColor: 'rgba(255,255,255,0.5)',
  },
  endBtn: {
    backgroundColor: '#FF3B30',
    width: 80,
  },
  ctrlLabel: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
  endLabel: {
    fontSize: 15,
  },
});
