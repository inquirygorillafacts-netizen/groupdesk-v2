require('dotenv').config();
const { Client } = require('pg');

async function setupDatabase() {
    const connectionString = process.env.DATABASE_URL;

    if (!connectionString || connectionString.includes('[YOUR-PASSWORD]')) {
        console.error("Error: Please set a valid DATABASE_URL in your .env file.");
        process.exit(1);
    }

    const client = new Client({
        connectionString,
        ssl: { rejectUnauthorized: false }
    });

    try {
        await client.connect();
        console.log("Connected to Supabase PostgreSQL!");

        const sql = `
        -- 1. Create Groups Table
        create table if not exists groups (
          id text primary key,
          whatsapp_group_id text,
          name text,
          enabled boolean default false,
          anon_counter int default 0,
          last_at timestamp with time zone,
          last_preview text,
          unread int default 0
        );

        -- 2. Create Messages Table
        create table if not exists messages (
          id text primary key,
          group_id text references groups(id),
          sender_id text,
          sender_display text,
          kind text,
          direction text,
          type text,
          text text,
          media_url text,
          status text,
          reactions jsonb default '{}'::jsonb,
          quoted_msg jsonb,
          created_at timestamp with time zone default now()
        );

        -- Index for fast Pagination
        create index if not exists idx_messages_group_id on messages(group_id);
        create index if not exists idx_messages_created_at on messages(created_at desc);

        -- 3. Create Aliases Table
        create table if not exists aliases (
          id uuid default gen_random_uuid() primary key,
          group_id text,
          participant_id text,
          alias text
        );

        -- 4. Create Auth State Table
        create table if not exists auth_state (
          id text primary key,
          session_id text,
          file_name text,
          data jsonb
        );
        `;

        console.log("Running SQL queries to create tables...");
        await client.query(sql);
        console.log("✅ All tables created successfully!");

    } catch (err) {
        console.error("Error executing SQL:", err);
    } finally {
        await client.end();
    }
}

setupDatabase();
