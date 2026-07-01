// list-listings.js
// Run with: node list-listings.js
// Prints all regulatory listings in your project so you can copy the names into .env

const { RegulatoryListingsClient } = require('@enfonica/numbering');

// Directly point to the key file in your project root — no env var involved
const keyFile = require('path').resolve(__dirname, '1778493974316.json');

const PROJECT = 'projects/bele-ai-demo';

(async () => {
    try {
        const client = new RegulatoryListingsClient({
            keyFile, // <-- correct option name per Enfonica's own README
        });

        const [listings] = await client.listRegulatoryListings({
            parent: PROJECT,
        });

        if (!listings || listings.length === 0) {
            console.log('No regulatory listings found in this project.');
            return;
        }

        console.log(`Found ${listings.length} regulatory listing(s):\n`);

        listings.forEach((l) => {
            console.log('-----------------------------------');
            console.log('name        :', l.name);
            console.log('displayName :', l.displayName);
            console.log('regionCode  :', l.address?.regionCode);
            console.log('locality    :', l.address?.locality);
            console.log('valid       :', l.valid);
            console.log('verified    :', l.verified);
            console.log('type        :', l.person ? 'Person' : l.business ? 'Business' : 'Unknown');
        });

        console.log('\n-----------------------------------');
        console.log('Copy the relevant "name" values into your .env, e.g.:\n');

        const au = listings.find((l) => l.address?.regionCode === 'AU');
        const nz = listings.find((l) => l.address?.regionCode === 'NZ');

        if (au) console.log(`ENFONICA_REGULATORY_LISTING_AU=${au.name}`);
        if (nz) console.log(`ENFONICA_REGULATORY_LISTING_NZ=${nz.name}`);

    } catch (err) {
        console.error('Error fetching regulatory listings:', err);
    }
})();