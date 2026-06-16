import { describe, it, expect } from 'vitest';
import { encodeChatMessage, decodeChatMessage, type ChatMessage } from './chat-message';

const msg: ChatMessage = {
  id: '1',
  room: 'room-1',
  channel: 'private',
  senderIdentity: 'mod-abc',
  senderName: 'mod',
  senderRole: 'moderator',
  body: 'こんにちは',
  createdAt: '2026-06-15T00:00:00.000Z',
};

describe('chat-message encode/decode', () => {
  it('encode→decode でラウンドトリップする', () => {
    const decoded = decodeChatMessage(encodeChatMessage(msg));
    expect(decoded).toEqual(msg);
  });

  it('encode は Uint8Array を返す', () => {
    expect(encodeChatMessage(msg)).toBeInstanceOf(Uint8Array);
  });
});
