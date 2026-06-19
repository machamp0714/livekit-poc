create table if not exists chat_messages (
  id              bigserial primary key,
  room            text not null,
  channel         text not null check (channel in ('public','private','observer_only')),
  sender_identity text not null,
  sender_name     text,
  sender_role     text not null check (sender_role in ('moderator','panelist','observer')),
  body            text not null,
  created_at      timestamptz not null default now()
);
create index if not exists chat_messages_room_channel_time_idx
  on chat_messages (room, channel, created_at);
