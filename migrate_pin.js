const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function run() {
    try {
        console.log('Adding admin_pin column to app_settings...');
        await pool.query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS admin_pin VARCHAR(20) DEFAULT '1234'`);
        
        // Also add admin_pin to setup_settings.js so future setups work
        console.log('Column added successfully.');
    } catch(e) {
        console.error('Migration error:', e);
    } finally {
        pool.end();
    }
}
run();
