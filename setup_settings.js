require('dotenv').config();
const { Client } = require('pg');

async function setupSettings() {
    const connectionString = process.env.DATABASE_URL;
    const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });

    try {
        await client.connect();
        console.log("Setting up app_settings table...");

        const sql = `
            create table if not exists app_settings (
                id int primary key,
                auto_delete_enabled boolean default false,
                auto_delete_days int default 60,
                admin_pin varchar(20) default '1234'
            );
            
            -- Insert default row if not exists
            INSERT INTO app_settings (id, auto_delete_enabled, auto_delete_days) 
            VALUES (1, false, 60)
            ON CONFLICT (id) DO NOTHING;
            
            -- Enable RLS to block public access
            ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;
        `;
        await client.query(sql);
        console.log("✅ app_settings table created successfully!");
    } catch (err) {
        console.error("Error creating settings table:", err);
    } finally {
        await client.end();
    }
}
setupSettings();
