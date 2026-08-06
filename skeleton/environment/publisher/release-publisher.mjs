import duckdb from "duckdb";
import fs from "fs"
import { randomUUID } from "crypto";
import { spawnSync } from "child_process";
import util from "util"

const getCurrentKey = async () => {
    const res = await fetch('http://127.0.0.1:7070/v1/signing-key/current')
    return await res.json()
}

const createDescriptor = (bundleId, artifactCount, totalBytes) => {
    const descriptor = {
        artifact_count: artifactCount,
        bundle_id: bundleId,
        total_bytes: totalBytes
    }
    return JSON.stringify(descriptor,  Object.keys(descriptor).sort()).trim();
} 

const signDescriptor = (descriptor) => {
    const descriptorFilepath = `/app/tmp/descriptor-${randomUUID()}.bin`
    fs.writeFileSync(descriptorFilepath, descriptor, 'utf8')
    const currentCertPath = '/app/keys/current/current.cert.pem'
    const currentKeyPath = '/app/keys/current/current.key.pem'

    const signature = spawnSync(
        'openssl',
        [
        'cms', '-sign', '-in', descriptorFilepath,
        '-signer', currentCertPath, '-inkey', currentKeyPath,
        '-outform', 'PEM', '-binary',
        ],
        { encoding: 'utf8' }
    )
    fs.rmSync(descriptorFilepath, { force: true });
    return signature.stdout
}

const confirmPublication = async(descriptor, signature, token) => {
    const res = await fetch('http://127.0.0.1:7070/v1/publications', {
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

function getBundles(conn) {
    return new Promise((resolve, reject) => {
        conn.all(`SELECT bundle_id, COUNT(*) AS artifact_count, SUM(size_bytes) AS total_bytes FROM build_manifest where record_type = 'BUILD' AND entry_id NOT IN (select supersedes_id from build_manifest where record_type = 'WITHDRAWAL') GROUP BY bundle_id ORDER BY bundle_id`, function(err,res) {
            if (err) reject(err)
            else resolve(res)
        })
    })
}

function storeResult(conn, bundleId, token, pubId) {
    conn.run(`
        INSERT OR REPLACE INTO published_builds (
        bundle_id,
        request_token,
        publication_id
        ) VALUES (
        '${bundleId}','${token}','${pubId}' 
        )
    `)
}
 
async function main() {
    try {
        const db = new duckdb.Database(
            "releases.duckdb",
            {
                access_mode: "READ_WRITE",
                max_memory: "512MB",
                threads: "4",
            },
            (err) => {
                if (err) {
                    console.error(err);
                }
            },
        );

        const conn = db.connect();
        conn.run(
        `CREATE or REPLACE TABLE build_manifest AS SELECT * FROM './fixtures/build_manifest.csv'`, function (err, res) {
            if (err) console.log(err);
        });
        conn.run(`
            CREATE or REPLACE TABLE published_builds (
            bundle_id TEXT PRIMARY KEY,
            request_token TEXT,
            publication_id TEXT,
            published_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`, function (err, res) {
            if (err) console.log(err);
            console.log(res);
        })
        const res = await getBundles(conn);
        const bundles = res.map(bundle =>({bundle_id: bundle.bundle_id, artifact_count: Number(bundle.artifact_count), total_bytes: Number(bundle.total_bytes)}))
        const currentKey = await getCurrentKey();
        bundles.forEach(async (bundle) => {
            const token = `token-${bundle.bundle_id}`
            const descriptor = createDescriptor(bundle.bundle_id, bundle.artifact_count, bundle.total_bytes)
            const signature = signDescriptor(descriptor)
            const published = await confirmPublication(descriptor,signature,token)
            storeResult(conn, bundle.bundle_id, published.request_token, published.publication_id)
            console.log(`BUNDLE ${bundle.bundle_id} SIGNED KEY=${currentKey.key_id}`)
            console.log(`BUNDLE ${bundle.bundle_id} PUBLISHED RECEIPT=${published.publication_id} TOKEN=${published.request_token} STATUS=${published.status}`)
        });
    } catch (error) {
        console.log("Error", error);
    }
}
await main();