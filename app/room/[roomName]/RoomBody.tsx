'use client';

import {
  ControlBar,
  GridLayout,
  ParticipantTile,
  useConnectionState,
  useParticipants,
  useTracks,
} from '@livekit/components-react';
import { Track } from 'livekit-client';
import { canBroadcast, type Role } from '@/lib/livekit/roles';
import { DiagnosticsPanel } from './DiagnosticsPanel';
import { RecordingControls } from './RecordingControls';
import { ModeratorControls } from './ModeratorControls';

export function RoomBody({ role, roomName }: { role: Role, roomName: string }) {
  const trackRefs = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: false },
  );
  const connectionState = useConnectionState();
  const participants = useParticipants();

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        height: '75vh',
      }}
    >
      <header style={{ fontSize: 14 }}>
        接続状態: {connectionState} / 参加者数: {participants.length}
      </header>

      <GridLayout tracks={trackRefs} style={{ flex: 1, minHeight: 0 }}>
        <ParticipantTile />
      </GridLayout>

      <DiagnosticsPanel />

      {role === 'moderator' && (
        <>
          <RecordingControls roomName={roomName} />
          <ModeratorControls roomName={roomName} />
        </>
      )}

      {canBroadcast(role) ? (
        <ControlBar
          controls={{
            microphone: true,
            camera: true,
            screenShare: true,
            leave: true,
          }}
        />
      ) : (
        <p style={{ fontSize: 12, color: '#666' }}>
          観覧モード（オブザーバー）：視聴のみ。マイク・カメラは送信しません。
        </p>
      )}
    </div>
  );
}

