import fs from 'node:fs';

const signatures = {
  'application/pdf': (buffer, length) => length >= 5 && buffer.subarray(0, 5).toString('ascii') === '%PDF-',
  'image/png': (buffer, length) => length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
  'image/jpeg': (buffer, length) => length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff,
  'image/tiff': (buffer, length) => length >= 4 && ['49492a00', '4d4d002a'].includes(buffer.subarray(0, 4).toString('hex'))
};

export function validFile(filePath, mimeType) {
  const matches = signatures[mimeType];
  if (!matches) return false;

  let descriptor;
  try {
    descriptor = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(12);
    const bytesRead = fs.readSync(descriptor, header, 0, header.length, 0);
    return matches(header, bytesRead);
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}
