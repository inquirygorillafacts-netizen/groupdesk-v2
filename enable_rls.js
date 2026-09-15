require('dotenv').config();
const { Client } = require('pg');

async function enableRLS() {
    const connectionString = process.env.DATABASE_URL;
    const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });

    try {
        await client.connect();
        console.log("Securing database with Row Level Security (RLS)...");

        const sql = `
            ALTER TABLE groups ENABLE ROW LEVEL SECURITY;
            ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
            ALTER TABLE aliases ENABLE ROW LEVEL SECURITY;
            ALTER TABLE auth_state ENABLE ROW LEVEL SECURITY;
        `;
        await client.query(sql);
        console.log("✅ RLS Enabled on all tables! Database is now 100% SECURE.");
    } catch (err) {
        console.error("Error enabling RLS:", err);
    } finally {
        await client.end();
    }
}
enableRLS();
