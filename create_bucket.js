require('dotenv').config();
const { Client } = require('pg');

async function setupBucket() {
    const connectionString = process.env.DATABASE_URL;
    const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });

    try {
        await client.connect();
        console.log("Checking storage bucket...");

        // Create 'uploads' bucket if it doesn't exist
        const sql = `
            insert into storage.buckets (id, name, public) 
            values ('uploads', 'uploads', true)
            on conflict (id) do nothing;
        `;
        await client.query(sql);
        console.log("✅ Storage bucket 'uploads' is ready!");
    } catch (err) {
        console.error("Error creating bucket:", err);
    } finally {
        await client.end();
    }
}
setupBucket();
