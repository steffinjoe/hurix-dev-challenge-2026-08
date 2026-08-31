// ==== IMPORTS ====

import duckdb from "duckdb";
import fs from "node:fs"
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

// ===== CONSTANTS ======

const GET_SIGNING_KEY_URL = 'http://127.0.0.1:7070/v1/signing-key/current';
const CURRENT_CERT_PATH = '/app/keys/current/current.cert.pem';
const CURRENT_KEY_PATH = '/app/keys/current/current.key.pem';
const PUBLICATIONS_URL = 'http://127.0.0.1:7070/v1/publications';
const MANIFEST_FILE_PATH = './fixtures/build_manifest.csv';
const DB_NAME = 'releases.duckdb'

/**
 * Fetches current signing key using V1 signing key API
 * @returns current signing key
 */
const getCurrentKey = async () => {
    const res = await fetch(GET_SIGNING_KEY_URL)
    return await res.json()
}

/**
 * Creates the description string which is stringified object containing bundleId, artifactCount and totalBytes
 * @param {string} bundleId 
 * @param {Number} artifactCount 
 * @param {Number} totalBytes 
 * @returns description string
 */
const createDescriptor = (bundleId, artifactCount, totalBytes) => {
    const descriptor = {
        artifact_count: artifactCount,
        bundle_id: bundleId,
        total_bytes: totalBytes
    }
    return JSON.stringify(descriptor, Object.keys(descriptor).sort()).trim();
}

/**
 * Uses the descriptor string and signs descriptor file and current certificate/key
 * @param {string} descriptor 
 * @returns 
 */
const signDescriptor = (descriptor) => {
    const descriptorFilepath = `/tmp/descriptor-${randomUUID()}.bin`
    fs.writeFileSync(descriptorFilepath, descriptor, 'utf8')

    const signature = spawnSync(
        'openssl',
        [
            'cms', '-sign', '-in', descriptorFilepath,
            '-signer', CURRENT_CERT_PATH, '-inkey', CURRENT_KEY_PATH,
            '-outform', 'PEM', '-binary',
        ],
        { encoding: 'utf8' }
    )
    fs.rmSync(descriptorFilepath, { force: true });
    return signature.stdout
}

/**
 * Calls publication URL to confirm publication
 * @param {string} descriptor 
 * @param {string} signature 
 * @param {string} token 
 * @returns confirm publication API result
 */
const confirmPublication = async (descriptor, signature, token) => {
    const res = await fetch(PUBLICATIONS_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            descriptor: descriptor,
            signature: signature,
            request_token: token,
        }),
    })
    return await res.json()
}

/**
 * Fetches all the bundles from build_manifest table
 * @param {duckdb.Connection} conn 
 * @returns all bundles
 */
function getBundles(conn) {
    return new Promise((resolve, reject) => {
        conn.all(`SELECT bundle_id, COUNT(*) AS artifact_count, SUM(size_bytes) AS total_bytes FROM build_manifest where record_type = 'BUILD' AND entry_id NOT IN (select supersedes_id from build_manifest where record_type = 'WITHDRAWAL') GROUP BY bundle_id ORDER BY bundle_id`, function (err, res) {
            if (err) reject(err)
            else resolve(res)
        })
    })
}

/**
 * Stores the published build results in published_builds table
 * @param {duckdb.Connection} conn 
 * @param {string} bundleId 
 * @param {string} token 
 * @param {string} pubId 
 */
function storeResult(conn, bundleId, token, pubId, status) {
    conn.run(`
        INSERT OR REPLACE INTO published_builds (
        bundle_id,
        request_token,
        publication_id,
        status
        ) VALUES (
        '${bundleId}','${token}','${pubId}', '${status}' 
        )
    `, function (err, res) {
        if (err) console.log(err);
    })
}

/**
 * Check if build already published in previous runs
 * @param {duckdb.Connection} conn
 * @param {string} bundleId
 */
function getExistingPublishedBuilds(conn) {
    return new Promise((resolve, reject) => {
        conn.all(`
            SELECT bundle_id, publication_id, request_token, status from  published_builds WHERE status = 'PUBLISHED'
            `, function (err, res) {
            if (err) reject(err)
            else resolve(res)
        })
    })
}

/**
 * creates the build_manifest table in duckDB and imports data using build_manifest.csv
 * @param {duckdb.Connection} conn 
 */
function createBuildManifestTable(conn) {
    conn.run(
        `CREATE TABLE IF NOT EXISTS build_manifest AS SELECT * FROM '${MANIFEST_FILE_PATH}'`, function (err, res) {
            if (err) console.log(err);
        });
}

/**
 * creates the published_builds table which stores the results after checking build manifests
 * @param {duckdb.Connection} conn 
 */
function createPublishedBuildTable(conn) {
    conn.run(`
        CREATE TABLE IF NOT EXISTS published_builds (
        bundle_id TEXT PRIMARY KEY,
        request_token TEXT,
        publication_id TEXT,
        published_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        status TEXT
    )`, function (err, res) {
        if (err) console.log(err);
    })
}

/**
 * Initialize/Create Database
 * @returns 
 */
function createDB() {
    return new duckdb.Database(
        DB_NAME,
        (err) => {
            if (err) {
                console.error(err);
            }
        },
    );
}

/**
 * Main function
 */
async function main() {
    try {
        // setup duckDb and required tables
        const db = createDB();
        const conn = db.connect();
        createBuildManifestTable(conn);
        createPublishedBuildTable(conn);

        // Fetch existing published bundles to avoid re-runs
        const existingBundles = await getExistingPublishedBuilds(conn);
        const bundleIds = new Set(existingBundles.map(bundle=>bundle.bundle_id));

        // Fetch all bundles and parse the required fields for descriptor data
        const res = await getBundles(conn);
        const bundles = res.map(bundle => ({ bundle_id: bundle.bundle_id, artifact_count: Number(bundle.artifact_count), total_bytes: Number(bundle.total_bytes) }))
        const currentKey = await getCurrentKey();
        
        // Process bundles
        bundles.forEach(async (bundle) => {
            const token = `token-${bundle.bundle_id}`
            let published;
            if (!bundleIds.has(bundle.bundle_id)) {
                const descriptor = createDescriptor(bundle.bundle_id, bundle.artifact_count, bundle.total_bytes)
                const signature = signDescriptor(descriptor)
                published = await confirmPublication(descriptor, signature, token)
                storeResult(conn, bundle.bundle_id, published.request_token, published.publication_id, published.status)
            } else {
                published = existingBundles.find(existingBundle=>existingBundle.bundle_id === bundle.bundle_id)
            }
            console.log(`BUNDLE ${bundle.bundle_id} SIGNED KEY=${currentKey.key_id}`)
            console.log(`BUNDLE ${bundle.bundle_id} PUBLISHED RECEIPT=${published.publication_id} TOKEN=${published.request_token} STATUS=${published.status}`)
        });
    } catch (error) {
        console.log("Error", error);
    }
}

await main();