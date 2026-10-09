const VERSION = 10;
const SIZE = VERSION * 4 + 17;
const DATA_CODEWORDS = 274;
const ECC_CODEWORDS_PER_BLOCK = 18;
const DATA_BLOCK_LENGTHS = [68, 68, 69, 69] as const;
const BYTE_CAPACITY = 271;
const ALIGNMENT_PATTERN_CENTERS = [6, 28, 50] as const;

export type QrMatrix = boolean[][];

function appendBits(target: number[], value: number, count: number) {
  for (let bit = count - 1; bit >= 0; bit -= 1) {
    target.push((value >>> bit) & 1);
  }
}

function createDataCodewords(value: string) {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length > BYTE_CAPACITY) {
    throw new Error(`QR version 10-L supports at most ${BYTE_CAPACITY} UTF-8 bytes.`);
  }

  const bits: number[] = [];
  appendBits(bits, 0b0100, 4);
  appendBits(bits, bytes.length, 16);
  for (const byte of bytes) appendBits(bits, byte, 8);

  const capacityBits = DATA_CODEWORDS * 8;
  const terminatorLength = Math.min(4, capacityBits - bits.length);
  for (let index = 0; index < terminatorLength; index += 1) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  let padIndex = 0;
  const padBytes = [0xec, 0x11] as const;
  while (bits.length < capacityBits) {
    appendBits(bits, padBytes[padIndex % 2]!, 8);
    padIndex += 1;
  }

  const codewords: number[] = [];
  for (let offset = 0; offset < bits.length; offset += 8) {
    let codeword = 0;
    for (let bit = 0; bit < 8; bit += 1) {
      codeword = (codeword << 1) | bits[offset + bit]!;
    }
    codewords.push(codeword);
  }
  return codewords;
}

function reedSolomonMultiply(left: number, right: number) {
  let product = 0;
  for (let bit = 7; bit >= 0; bit -= 1) {
    product = (product << 1) ^ (((product >>> 7) & 1) * 0x11d);
    product ^= ((right >>> bit) & 1) * left;
  }
  return product & 0xff;
}

function createReedSolomonDivisor(degree: number) {
  const divisor = new Array<number>(degree).fill(0);
  divisor[degree - 1] = 1;
  let root = 1;

  for (let factor = 0; factor < degree; factor += 1) {
    for (let index = 0; index < degree; index += 1) {
      divisor[index] = reedSolomonMultiply(divisor[index]!, root);
      if (index + 1 < degree) {
        divisor[index] = divisor[index]! ^ divisor[index + 1]!;
      }
    }
    root = reedSolomonMultiply(root, 2);
  }
  return divisor;
}

function createReedSolomonRemainder(data: readonly number[], divisor: readonly number[]) {
  const remainder = new Array<number>(divisor.length).fill(0);
  for (const byte of data) {
    const factor = byte ^ remainder[0]!;
    remainder.shift();
    remainder.push(0);
    for (let index = 0; index < divisor.length; index += 1) {
      remainder[index] = remainder[index]! ^ reedSolomonMultiply(divisor[index]!, factor);
    }
  }
  return remainder;
}

function createAllCodewords(value: string) {
  const dataCodewords = createDataCodewords(value);
  const divisor = createReedSolomonDivisor(ECC_CODEWORDS_PER_BLOCK);
  const blocks: Array<{ data: number[]; ecc: number[] }> = [];
  let offset = 0;

  for (const dataLength of DATA_BLOCK_LENGTHS) {
    const data = dataCodewords.slice(offset, offset + dataLength);
    offset += dataLength;
    blocks.push({ data, ecc: createReedSolomonRemainder(data, divisor) });
  }

  const result: number[] = [];
  const longestDataBlock = Math.max(...DATA_BLOCK_LENGTHS);
  for (let index = 0; index < longestDataBlock; index += 1) {
    for (const block of blocks) {
      if (index < block.data.length) result.push(block.data[index]!);
    }
  }
  for (let index = 0; index < ECC_CODEWORDS_PER_BLOCK; index += 1) {
    for (const block of blocks) result.push(block.ecc[index]!);
  }
  return result;
}

function getBit(value: number, bit: number) {
  return ((value >>> bit) & 1) !== 0;
}

function setFunctionModule(matrix: QrMatrix, functionModules: QrMatrix, x: number, y: number, value: boolean) {
  matrix[y]![x] = value;
  functionModules[y]![x] = true;
}

function drawFinderPattern(matrix: QrMatrix, functionModules: QrMatrix, centerX: number, centerY: number) {
  for (let deltaY = -4; deltaY <= 4; deltaY += 1) {
    for (let deltaX = -4; deltaX <= 4; deltaX += 1) {
      const x = centerX + deltaX;
      const y = centerY + deltaY;
      if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) continue;
      const distance = Math.max(Math.abs(deltaX), Math.abs(deltaY));
      setFunctionModule(matrix, functionModules, x, y, distance !== 2 && distance !== 4);
    }
  }
}

function drawAlignmentPattern(matrix: QrMatrix, functionModules: QrMatrix, centerX: number, centerY: number) {
  for (let deltaY = -2; deltaY <= 2; deltaY += 1) {
    for (let deltaX = -2; deltaX <= 2; deltaX += 1) {
      const distance = Math.max(Math.abs(deltaX), Math.abs(deltaY));
      setFunctionModule(matrix, functionModules, centerX + deltaX, centerY + deltaY, distance !== 1);
    }
  }
}

function drawFormatBits(matrix: QrMatrix, functionModules: QrMatrix) {
  const data = 1 << 3;
  let remainder = data;
  for (let index = 0; index < 10; index += 1) {
    remainder = (remainder << 1) ^ (((remainder >>> 9) & 1) * 0x537);
  }
  const bits = ((data << 10) | remainder) ^ 0x5412;

  for (let index = 0; index <= 5; index += 1) setFunctionModule(matrix, functionModules, 8, index, getBit(bits, index));
  setFunctionModule(matrix, functionModules, 8, 7, getBit(bits, 6));
  setFunctionModule(matrix, functionModules, 8, 8, getBit(bits, 7));
  setFunctionModule(matrix, functionModules, 7, 8, getBit(bits, 8));
  for (let index = 9; index < 15; index += 1) setFunctionModule(matrix, functionModules, 14 - index, 8, getBit(bits, index));

  for (let index = 0; index < 8; index += 1) setFunctionModule(matrix, functionModules, SIZE - 1 - index, 8, getBit(bits, index));
  for (let index = 8; index < 15; index += 1) setFunctionModule(matrix, functionModules, 8, SIZE - 15 + index, getBit(bits, index));
  setFunctionModule(matrix, functionModules, 8, SIZE - 8, true);
}

function drawVersionBits(matrix: QrMatrix, functionModules: QrMatrix) {
  let remainder = VERSION;
  for (let index = 0; index < 12; index += 1) {
    remainder = (remainder << 1) ^ (((remainder >>> 11) & 1) * 0x1f25);
  }
  const bits = (VERSION << 12) | remainder;
  for (let index = 0; index < 18; index += 1) {
    const value = getBit(bits, index);
    const first = SIZE - 11 + (index % 3);
    const second = Math.floor(index / 3);
    setFunctionModule(matrix, functionModules, first, second, value);
    setFunctionModule(matrix, functionModules, second, first, value);
  }
}

function drawFunctionPatterns(matrix: QrMatrix, functionModules: QrMatrix) {
  for (let index = 0; index < SIZE; index += 1) {
    const value = index % 2 === 0;
    setFunctionModule(matrix, functionModules, 6, index, value);
    setFunctionModule(matrix, functionModules, index, 6, value);
  }

  drawFinderPattern(matrix, functionModules, 3, 3);
  drawFinderPattern(matrix, functionModules, SIZE - 4, 3);
  drawFinderPattern(matrix, functionModules, 3, SIZE - 4);

  const lastAlignmentIndex = ALIGNMENT_PATTERN_CENTERS.length - 1;
  ALIGNMENT_PATTERN_CENTERS.forEach((x, xIndex) => {
    ALIGNMENT_PATTERN_CENTERS.forEach((y, yIndex) => {
      const overlapsFinder =
        (xIndex === 0 && yIndex === 0) ||
        (xIndex === 0 && yIndex === lastAlignmentIndex) ||
        (xIndex === lastAlignmentIndex && yIndex === 0);
      if (!overlapsFinder) drawAlignmentPattern(matrix, functionModules, x, y);
    });
  });

  drawFormatBits(matrix, functionModules);
  drawVersionBits(matrix, functionModules);
}

function drawCodewords(matrix: QrMatrix, functionModules: QrMatrix, codewords: readonly number[]) {
  const bits: number[] = [];
  for (const codeword of codewords) appendBits(bits, codeword, 8);

  let bitIndex = 0;
  for (let right = SIZE - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < SIZE; vertical += 1) {
      const upward = ((right + 1) & 2) === 0;
      const y = upward ? SIZE - 1 - vertical : vertical;
      for (let column = 0; column < 2; column += 1) {
        const x = right - column;
        if (functionModules[y]![x] || bitIndex >= bits.length) continue;
        let value = bits[bitIndex] === 1;
        bitIndex += 1;
        if ((x + y) % 2 === 0) value = !value;
        matrix[y]![x] = value;
      }
    }
  }

  if (bitIndex !== bits.length) throw new Error('QR data placement did not consume every codeword bit.');
}

export function createQrMatrix(value: string): QrMatrix {
  const matrix = Array.from({ length: SIZE }, () => new Array<boolean>(SIZE).fill(false));
  const functionModules = Array.from({ length: SIZE }, () => new Array<boolean>(SIZE).fill(false));
  drawFunctionPatterns(matrix, functionModules);
  drawCodewords(matrix, functionModules, createAllCodewords(value));
  return matrix;
}

export function createQrSvgDataUri(value: string) {
  const matrix = createQrMatrix(value);
  const quietZone = 4;
  const viewSize = SIZE + quietZone * 2;
  const commands: string[] = [];

  matrix.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (!row[x]) {
        x += 1;
        continue;
      }
      const start = x;
      while (x < row.length && row[x]) x += 1;
      const length = x - start;
      commands.push(`M${start + quietZone} ${y + quietZone}h${length}v1h-${length}z`);
    }
  });

  const svg = `<svg viewBox="0 0 ${viewSize} ${viewSize}" role="img" aria-label="QR code"><rect width="${viewSize}" height="${viewSize}" fill="white"/><path d="${commands.join('')}" fill="black"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
