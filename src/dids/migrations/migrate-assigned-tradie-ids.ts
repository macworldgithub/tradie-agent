import * as mongoose from 'mongoose';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load .env from the project root
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
  console.error('MONGO_URI is not defined in .env');
  process.exit(1);
}

// Minimal schema to read/update the relevant fields
const DidSchema = new mongoose.Schema({
  assignedTradieId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tradie' },
  assignedTradieIds: [{ type: String }],
}, { strict: false });

const Did = mongoose.model('Did', DidSchema, 'dids'); // Assuming the collection is named 'dids'

async function migrate() {
  try {
    await mongoose.connect(MONGO_URI as string);
    console.log('Connected to MongoDB');

    // Find DIDs where assignedTradieId exists, but assignedTradieIds is missing or empty
    const didsToMigrate = await Did.find({
      assignedTradieId: { $exists: true, $ne: null },
      $or: [
        { assignedTradieIds: { $exists: false } },
        { assignedTradieIds: { $size: 0 } }
      ]
    });

    console.log(`Found ${didsToMigrate.length} DIDs to migrate.`);

    for (const did of didsToMigrate) {
      if (did.assignedTradieId) {
        // Backfill the array with the single assignedTradieId
        did.assignedTradieIds = [did.assignedTradieId.toString()];
        await did.save();
        console.log(`Migrated DID ${did._id} (added tradie ${did.assignedTradieId.toString()})`);
      }
    }

    console.log('Migration complete.');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

migrate();
