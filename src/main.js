const core = require('@actions/core');

const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { GetObjectCommand, S3 } = require('@aws-sdk/client-s3');

const fs = require('fs');
const path = require('path');
const qr = require('qrcode');

const NODE_ENV = process.env['NODE_ENV'];

// If you want to run it locally, set the environment variables like `$ export SOME_KEY=<your token>`
const AWS_ACCESS_KEY_ID = process.env['AWS_ACCESS_KEY_ID'];
const AWS_SECRET_ACCESS_KEY = process.env['AWS_SECRET_ACCESS_KEY'];
const AWS_BUCKET = process.env['AWS_BUCKET'];

let input;
if (NODE_ENV != 'local') {
  input = {
    awsAccessKeyId: core.getInput('aws-access-key-id', { required: true }),
    awsSecretAccessKey: core.getInput('aws-secret-access-key', { required: true }),
    awsRegion: core.getInput('aws-region', { required: true }),
    awsBucket: core.getInput('aws-bucket', { required: true }),
    filePath: core.getInput('file-path', { required: true }),
    destinationDir: core.getInput('destination-dir'),
    bucketRoot: core.getInput('bucket-root'),
    outputFileUrl: core.getInput('output-file-url'),
    contentType: core.getInput('content-type'),
    contentDisposition: core.getInput('content-disposition'),
    outputQrUrl: core.getInput('output-qr-url'),
    qrWidth: core.getInput('qr-width'),
    public: core.getInput('public'),
    expire: core.getInput('expire'),
    alternativeDomainPublic: core.getInput('alternative-domain-public'),
    alternativeDomainPrivate: core.getInput('alternative-domain-private'),
		tags: core.getInput('tags'),
		checksumAlgorithm: core.getInput('checksum-algorithm'),
		checksum: core.getInput('checksum'),
  };
} else {
  input = {
    awsAccessKeyId: AWS_ACCESS_KEY_ID,
    awsSecretAccessKey: AWS_SECRET_ACCESS_KEY,
    awsRegion: 'ap-northeast-1',
    awsBucket: AWS_BUCKET,
    filePath: './README.md',
    destinationDir: '',
    bucketRoot: '',
    outputFileUrl: 'true',
    contentType: '',
    contentDisposition: '',
    outputQrUrl: 'true',
    qrWidth: '120',
    public: 'false',
    expire: '180',
    alternativeDomainPublic: '',
    alternativeDomainPrivate: '',
    tags: '',
		checksumAlgorithm: '',
		checksum: '',
  };
}

const s3 = new S3({
  credentials: {
    accessKeyId: input.awsAccessKeyId,
    secretAccessKey: input.awsSecretAccessKey,
  },
  region: input.awsRegion,
});

async function run(input) {

  const expire = parseInt(input.expire);
  if (isNaN(expire) | expire < 0 | 604800 < expire) {
    throw new Error('"expire" input should be a number between 0 and 604800.');
  }

  const qrWidth = parseInt(input.qrWidth);
  if (!qrWidth | qrWidth < 100 | 1000 < qrWidth) {
    throw new Error('"qr-width" input should be a number between 100 and 1000.');
  }

  let bucketRoot = input.bucketRoot;
  if (bucketRoot) {
    if (bucketRoot.startsWith('/')) {
      bucketRoot = bucketRoot.slice(1);
    }
    if (bucketRoot && !bucketRoot.endsWith('/')) {
      bucketRoot = bucketRoot + '/'
    }
  } else {
    bucketRoot = 'artifacts/'; // Do not use the default value of input to match the behavior with destinationDir
  }

  let destinationDir = input.destinationDir;
  if (destinationDir) {
    if (destinationDir.startsWith('/')) {
      destinationDir = destinationDir.slice(1);
    }
    if (destinationDir && !destinationDir.endsWith('/')) {
      destinationDir = destinationDir + '/'
    }
  } else {
    destinationDir = getRandomStr(32) + '/';
  }

  const fileKey = bucketRoot + destinationDir + path.basename(input.filePath);

  let acl;
  if (input.public == 'true') {
    acl = 'public-read';
  } else {
    acl = 'private';
  }

  // Parse comma-separated tags (e.g., "Key1=Value1,Key2=Value2")
  let tagging;
  if (input.tags) {
    tagging = input.tags
    .split(',')
    .map(pair => pair.trim())
    .filter(Boolean)
    .map(pair => {
      const [Key, Value] = pair.split('=');
      return { Key: Key.trim(), Value: (Value || '').trim() };
    });
  }

  let params = {
    Bucket: input.awsBucket,
    Key: fileKey,
    ContentType: input.contentType,
    ContentDisposition: input.contentDisposition || "inline",
    Body: fs.readFileSync(input.filePath),
    ACL: acl,
  };

  if (tagging) {
    params.Tagging = tagging.map(t => `${t.Key}=${t.Value}`).join('&');
  }

	// Checksum handling
	if (input.checksumAlgorithm !== '') {
		if (!["CRC32","CRC32C","CRC64NVME","SHA1","SHA256"].includes(input.checksumAlgorithm)) {
			throw new Error(`Unsupported checksum algorithm: ${input.checksumAlgorithm}`);
		}
		params.ChecksumAlgorithm = input.checksumAlgorithm;

		// User-provided checksum value, send this instead of allowing the SDK to calculate it
		if (input.checksum!=="") {
			// AWS wants base64-encoded checksums, if the provided checksum is in hex, convert it
			let checksumValue = input.checksum;
			if (/^[0-9a-fA-F]+$/.test(checksumValue)) {
				const buffer = Buffer.from(checksumValue, 'hex');
				checksumValue = buffer.toString('base64');
			}
			switch (input.checksumAlgorithm) {
				case "CRC32":
					params.ChecksumCRC32 = checksumValue;
					break;
				case "CRC32C":
					params.ChecksumCRC32C = checksumValue;
					break;
				case "CRC64NVME":
					params.ChecksumCRC64NVME = checksumValue;
					break;
				case "SHA1":
					params.ChecksumSHA1 = checksumValue;
					break;
				case "SHA256":
					params.ChecksumSHA256 = checksumValue;
					break;
			}
		}
	}

  await s3.putObject(params);

  let fileUrl;
  if (input.outputFileUrl == 'true' || input.outputQrUrl == 'true') {
    if (input.public == 'true') {
      fileUrl = `https://${input.awsBucket}.s3.${input.awsRegion}.amazonaws.com/${fileKey}`;
      if (input.alternativeDomainPublic) {
        fileUrl = fileUrl.replace(`${input.awsBucket}.s3.${input.awsRegion}.amazonaws.com/${bucketRoot}`, `${input.alternativeDomainPublic}/`);
      }
    } else {
      fileUrl = await getSignedUrl(s3, new GetObjectCommand({
				Bucket: input.awsBucket,
				Key: fileKey,
			}), {
				expiresIn: expire,
      });
      if (input.alternativeDomainPrivate) {
        fileUrl = fileUrl.replace(`${input.awsBucket}.s3.${input.awsRegion}.amazonaws.com/${bucketRoot}`, `${input.alternativeDomainPrivate}/`);
      }
    }
    if (input.outputFileUrl == 'true') {
      core.setOutput('file-url', fileUrl);
    }
  }

  if (input.outputQrUrl != 'true') return;

  const qrKey = bucketRoot + destinationDir + 'qr.png';
  const tmpQrFile = './s3-upload-action-qr.png';

  await qr.toFile(tmpQrFile, fileUrl, { width: qrWidth })

  await s3.putObject({
		Bucket: input.awsBucket,
		Key: qrKey,
		ContentType: 'image/png', // Required to display as an image in the browser
		Body: fs.readFileSync(tmpQrFile),
		ACL: 'public-read', // always public
	});
  fs.unlinkSync(tmpQrFile);

  let qrUrl = `https://${input.awsBucket}.s3.${input.awsRegion}.amazonaws.com/${qrKey}`;
  if (input.alternativeDomainPublic) {
    qrUrl = qrUrl.replace(`${input.awsBucket}.s3.${input.awsRegion}.amazonaws.com/${bucketRoot}`, `${input.alternativeDomainPublic}/`);
  }
  core.setOutput('qr-url', qrUrl);
}

run(input)
  .then(result => {
    core.setOutput('result', 'success');
  })
  .catch(error => {
    core.setOutput('result', 'failure');
    core.setFailed(error.message);
  });

function getRandomStr(length) {
  const c = 'abcdefghijklmnopqrstuvwxyzABCDEFGHJKLMNOPQRSTUVWXYZ0123456789';
  let r = '';
  for(let i = 0; i < length; i++) {
    r += c[Math.floor(Math.random() * c.length)];
  }
  return r;
}
