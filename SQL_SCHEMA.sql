-- SQL mínimo para membresías + pagos (Postgres)

create table if not exists payment_intents (
  commerce_order text primary key,
  plan_id text not null,
  email text not null,
  user_id text,
  flow_token text,
  flow_order bigint,
  status text not null default 'created',
  created_at timestamptz not null default now()
);

create table if not exists memberships (
  email text primary key,
  user_id text,
  plan_id text not null,
  tier text not null,
  status text not null default 'active',
  start_at timestamptz not null default now(),
  end_at timestamptz
);

create table if not exists payments (
  flow_order bigint primary key,
  commerce_order text,
  status int,
  raw jsonb,
  created_at timestamptz not null default now()
);
