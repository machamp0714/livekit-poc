import { describe, it, expect } from 'vitest';
import { rowToMessage } from './chat-db';

describe('rowToMessage', () => {
  it('DB 行を ChatMessage に変換する（id は文字列・created_at は ISO 文字列）', () => {
    const row = {
      id: 42,
      room: 'room-1',
      channel: 'public',
      sender_identity: 'pan-1',
      sender_name: 'panelist',
      sender_role: 'panelist',
      body: 'hi',
      created_at: new Date('2026-06-15T01:02:03.000Z'),
    };
    expect(rowToMessage(row)).toEqual({
      id: '42',
      room: 'room-1',
      channel: 'public',
      senderIdentity: 'pan-1',
      senderName: 'panelist',
      senderRole: 'panelist',
      body: 'hi',
      createdAt: '2026-06-15T01:02:03.000Z',
    });
  });
});
