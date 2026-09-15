require('dotenv').config();
const { Client } = require('pg');

async function setupRPCs() {
    const connectionString = process.env.DATABASE_URL;
    const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });

    try {
        await client.connect();
        console.log("Setting up PostgreSQL RPCs for scaling...");

        const sql = `
            -- Function to safely increment anon_counter and return the new value
            CREATE OR REPLACE FUNCTION increment_anon_counter(group_id_param text)
            RETURNS int
            LANGUAGE plpgsql
            AS $$
            DECLARE
                new_counter int;
            BEGIN
                UPDATE groups
                SET anon_counter = anon_counter + 1
                WHERE id = group_id_param
                RETURNING anon_counter INTO new_counter;
                
                RETURN new_counter;
            END;
            $$;

            -- Function to safely increment unread count
            CREATE OR REPLACE FUNCTION increment_unread(group_id_param text)
            RETURNS void
            LANGUAGE sql
            AS $$
                UPDATE groups
                SET unread = unread + 1
                WHERE id = group_id_param;
            $$;
        `;
        await client.query(sql);
        console.log("✅ RPCs created successfully!");
    } catch (err) {
        console.error("Error creating RPCs:", err);
    } finally {
        await client.end();
    }
}
setupRPCs();
