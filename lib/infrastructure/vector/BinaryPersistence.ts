/**
 * BinaryPersistence — 自定义二进制格式 (.asvec) 的序列化/反序列化
 *
 * 文件格式:
 * ┌─────────────────────────────────────┐
 * │ Header (32 bytes)                   │
 * │  Magic: "ASVEC" (5b)               │
 * │  Version: uint8 (1b)               │
 * │  Flags: uint16 (2b)                │
 * │  Dimension: uint16 (2b)            │
 * │  NumVectors: uint32 (4b)           │
 * │  HnswM: uint16 (2b)               │
 * │  HnswMaxLevel: uint16 (2b)        │
 * │  EntryPoint: uint32 (4b)           │
 * │  Reserved: (10b)                    │
 * ├─────────────────────────────────────┤
 * │ Quantizer (if flags.bit0)           │
 * │  Mins: Float32[dim]                │
 * │  Maxs: Float32[dim]               │
 * ├─────────────────────────────────────┤
 * │ Vectors section                     │
 * │  Per vector: idLen(u16) + id(utf8) │
 * │    + level(u8) + vector(f32*dim)   │
 * ├─────────────────────────────────────┤
 * │ Graph section                       │
 * │  Per level: numEntries(u32)         │
 * │    Per entry: nodeIdx(u32)          │
 * │      + numNeighbors(u16)            │
 * │      + neighbors(u32[])             │
 * ├─────────────────────────────────────┤
 * │ Metadata section (JSON)             │
 * │  metadataLen(u32) + JSON(utf8)      │
 * └─────────────────────────────────────┘
 *
 * @module infrastructure/vector/BinaryPersistence
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ScalarQuantizer } from './ScalarQuantizer.js';

const MAGIC = 'ASVEC';
const VERSION = 1;
const HEADER_SIZE = 32;

// Flags
const FLAG_HAS_QUANTIZER = 0x01;
const FLAG_HAS_HNSW_GRAPH = 0x02;
const FLAG_SQ8_VECTORS = 0x04; // vectors stored as Uint8 rather than Float32

export class BinaryPersistence {
  /**
   * 保存 HNSW 索引到二进制文件 (同步)
   *
   * @param {string} filePath - 文件路径 (.asvec)
   * @param {object} data
   * @param {import('./HnswIndex.js').HnswIndex} data.index - HNSW 索引
   * @param {import('./ScalarQuantizer.js').ScalarQuantizer|null} data.quantizer - 量化器
   * @param {Map<string, object>} data.metadata - 文档 metadata
   * @param {Map<string, string>} data.contents - 文档 content
   */
  static save(filePath, data) {
    const buffer = BinaryPersistence.encode(data);
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(filePath, buffer);
  }

  /**
   * 异步保存
   * @param {string} filePath
   * @param {object} data
   */
  static async saveAsync(filePath, data) {
    const buffer = BinaryPersistence.encode(data);
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    await writeFile(filePath, buffer);
  }

  /**
   * 加载二进制索引 (同步)
   * @param {string} filePath
   * @returns {{ index: object, quantizer: ScalarQuantizer|null, metadata: Map, contents: Map }}
   */
  static load(filePath) {
    const fileBuffer = readFileSync(filePath);
    return BinaryPersistence.decode(fileBuffer);
  }

  /**
   * 编码为 Buffer
   * @param {object} data
   * @returns {Buffer}
   */
  static encode(data) {
    const { index, quantizer, metadata, contents } = data;
    const indexData = index.serialize();

    // 过滤掉已删除的节点
    const activeNodes = indexData.nodes.filter((n) => n !== null);
    const dimension = activeNodes.length > 0 ? activeNodes[0].vector.length : 0;
    const numVectors = activeNodes.length;

    // 建立 nodeIdx → active 索引的映射 (用于重建 graph)
    const oldToNew = new Map();
    let newIdx = 0;
    for (let i = 0; i < indexData.nodes.length; i++) {
      if (indexData.nodes[i] !== null) {
        oldToNew.set(i, newIdx);
        newIdx++;
      }
    }

    // Flags
    let flags = FLAG_HAS_HNSW_GRAPH;
    if (quantizer?.trained) {
      flags |= FLAG_HAS_QUANTIZER;
    }

    // 安全校验: 维度 / level 范围
    if (dimension > 65535) {
      throw new Error(`BinaryPersistence: dimension ${dimension} exceeds UInt16 max (65535)`);
    }

    // ── 计算总大小 ──
    let totalSize = HEADER_SIZE;

    // Quantizer section
    if (flags & FLAG_HAS_QUANTIZER) {
      totalSize += dimension * 4 * 2; // mins + maxs
    }

    // Vectors section: 每个向量 = idLen(2) + id(N) + level(1) + vector(dim*4)
    let vectorsSectionSize = 0;
    for (const node of activeNodes) {
      const idBytes = Buffer.byteLength(node.id, 'utf-8');
      vectorsSectionSize += 2 + idBytes + 1 + dimension * 4;
    }
    totalSize += vectorsSectionSize;

    // Graph section: numLevels(u16) + per-level data
    let graphSectionSize = 2; // numLevels
    for (const levelEntries of indexData.graphs) {
      // 过滤掉已删除节点的条目
      const validEntries = levelEntries.filter(([idx]) => oldToNew.has(idx));
      graphSectionSize += 4; // numEntries
      for (const [, neighbors] of validEntries) {
        const validNeighbors = neighbors.filter((n) => oldToNew.has(n));
        graphSectionSize += 4 + 2 + validNeighbors.length * 4; // nodeIdx + numNeighbors + neighbors
      }
    }
    totalSize += graphSectionSize;

    // Metadata section
    const metadataObj = {};
    if (metadata) {
      for (const [key, value] of metadata) {
        metadataObj[key] = value;
      }
    }
    const contentsObj = {};
    if (contents) {
      for (const [key, value] of contents) {
        contentsObj[key] = value;
      }
    }
    const metaJson = JSON.stringify({ metadata: metadataObj, contents: contentsObj });
    const metaBytes = Buffer.from(metaJson, 'utf-8');
    totalSize += 4 + metaBytes.length; // metadataLen + JSON

    // ── 写入 ──
    const buf = Buffer.alloc(totalSize);
    let offset = 0;

    // Header
    buf.write(MAGIC, offset, 'ascii');
    offset += 5;
    buf.writeUInt8(VERSION, offset);
    offset += 1;
    buf.writeUInt16LE(flags, offset);
    offset += 2;
    buf.writeUInt16LE(dimension, offset);
    offset += 2;
    buf.writeUInt32LE(numVectors, offset);
    offset += 4;
    buf.writeUInt16LE(indexData.M, offset);
    offset += 2;
    buf.writeUInt16LE(indexData.maxLevel + 1, offset); // 存储为 numLevels
    offset += 2;
    // entryPoint 需要映射到新索引
    const newEntryPoint =
      indexData.entryPoint >= 0 ? (oldToNew.get(indexData.entryPoint) ?? 0) : 0xffffffff;
    buf.writeUInt32LE(newEntryPoint, offset);
    offset += 4;
    // Reserved
    buf.fill(0, offset, offset + 10);
    offset += 10;

    // Quantizer section
    if (flags & FLAG_HAS_QUANTIZER) {
      const qData = quantizer.serialize();
      for (let i = 0; i < dimension; i++) {
        buf.writeFloatLE(qData.mins[i] || 0, offset);
        offset += 4;
      }
      for (let i = 0; i < dimension; i++) {
        buf.writeFloatLE(qData.maxs[i] || 0, offset);
        offset += 4;
      }
    }

    // Vectors section
    for (const node of activeNodes) {
      const idBuf = Buffer.from(node.id, 'utf-8');
      buf.writeUInt16LE(idBuf.length, offset);
      offset += 2;
      idBuf.copy(buf, offset);
      offset += idBuf.length;
      buf.writeUInt8(Math.min(node.level, 255), offset);
      offset += 1;
      for (let i = 0; i < dimension; i++) {
        buf.writeFloatLE(node.vector[i] || 0, offset);
        offset += 4;
      }
    }

    // Graph section
    const numLevels = indexData.graphs.length;
    buf.writeUInt16LE(numLevels, offset);
    offset += 2;

    for (const levelEntries of indexData.graphs) {
      const validEntries = levelEntries.filter(([idx]) => oldToNew.has(idx));
      buf.writeUInt32LE(validEntries.length, offset);
      offset += 4;

      for (const [nodeIdx, neighbors] of validEntries) {
        const newNodeIdx = oldToNew.get(nodeIdx);
        buf.writeUInt32LE(newNodeIdx, offset);
        offset += 4;

        const validNeighbors = neighbors.filter((n) => oldToNew.has(n));
        buf.writeUInt16LE(validNeighbors.length, offset);
        offset += 2;

        for (const neighbor of validNeighbors) {
          buf.writeUInt32LE(oldToNew.get(neighbor), offset);
          offset += 4;
        }
      }
    }

    // Metadata section
    buf.writeUInt32LE(metaBytes.length, offset);
    offset += 4;
    metaBytes.copy(buf, offset);
    offset += metaBytes.length;

    return buf;
  }

  /**
   * 从 Buffer 解码
   * @param {Buffer} buf
   * @returns {{ indexData: object, quantizerData: object|null, metadata: Map, contents: Map, dimension: number }}
   */
  static decode(buf) {
    let offset = 0;

    // ── Header ──
    const magic = buf.toString('ascii', offset, offset + 5);
    offset += 5;
    if (magic !== MAGIC) {
      throw new Error(`Invalid ASVEC file: magic = "${magic}"`);
    }

    const version = buf.readUInt8(offset);
    offset += 1;
    if (version > VERSION) {
      throw new Error(`Unsupported ASVEC version: ${version} (max supported: ${VERSION})`);
    }

    const flags = buf.readUInt16LE(offset);
    offset += 2;
    const dimension = buf.readUInt16LE(offset);
    offset += 2;
    const numVectors = buf.readUInt32LE(offset);
    offset += 4;
    const hnswM = buf.readUInt16LE(offset);
    offset += 2;
    const numLevelsHeader = buf.readUInt16LE(offset);
    offset += 2;
    const entryPoint = buf.readUInt32LE(offset);
    offset += 4;
    offset += 10; // reserved

    // ── Quantizer ──
    let quantizerData = null;
    if (flags & FLAG_HAS_QUANTIZER) {
      const mins = new Array(dimension);
      for (let i = 0; i < dimension; i++) {
        mins[i] = buf.readFloatLE(offset);
        offset += 4;
      }
      const maxs = new Array(dimension);
      for (let i = 0; i < dimension; i++) {
        maxs[i] = buf.readFloatLE(offset);
        offset += 4;
      }
      quantizerData = { dimension, mins, maxs };
    }

    // ── Vectors ──
    const nodes = [];
    const idToIndex = new Map();
    for (let i = 0; i < numVectors; i++) {
      const idLen = buf.readUInt16LE(offset);
      offset += 2;
      const id = buf.toString('utf-8', offset, offset + idLen);
      offset += idLen;
      const level = buf.readUInt8(offset);
      offset += 1;
      const vector = new Float32Array(dimension);
      for (let d = 0; d < dimension; d++) {
        vector[d] = buf.readFloatLE(offset);
        offset += 4;
      }
      nodes.push({ id, vector: Array.from(vector), level });
      idToIndex.set(id, i);
    }

    // ── Graph ──
    const numLevels = buf.readUInt16LE(offset);
    offset += 2;
    const graphs = [];

    for (let l = 0; l < numLevels; l++) {
      const numEntries = buf.readUInt32LE(offset);
      offset += 4;
      const levelEntries = [];

      for (let e = 0; e < numEntries; e++) {
        const nodeIdx = buf.readUInt32LE(offset);
        offset += 4;
        const numNeighbors = buf.readUInt16LE(offset);
        offset += 2;
        const neighbors = [];
        for (let n = 0; n < numNeighbors; n++) {
          neighbors.push(buf.readUInt32LE(offset));
          offset += 4;
        }
        levelEntries.push([nodeIdx, neighbors]);
      }
      graphs.push(levelEntries);
    }

    // ── Metadata ──
    const metadata = new Map();
    const contents = new Map();

    if (offset < buf.length) {
      const metaLen = buf.readUInt32LE(offset);
      offset += 4;
      if (metaLen > 0) {
        const metaJson = buf.toString('utf-8', offset, offset + metaLen);
        offset += metaLen;
        try {
          const parsed = JSON.parse(metaJson);
          if (parsed.metadata) {
            for (const [key, value] of Object.entries(parsed.metadata)) {
              metadata.set(key, value);
            }
          }
          if (parsed.contents) {
            for (const [key, value] of Object.entries(parsed.contents)) {
              contents.set(key, value);
            }
          }
        } catch {
          /* corrupted metadata — ignore */
        }
      }
    }

    // 构建 HNSW 反序列化数据
    const maxLevel = numLevelsHeader > 0 ? numLevelsHeader - 1 : -1;
    const indexData = {
      M: hnswM,
      M0: hnswM * 2,
      efConstruct: 200,
      efSearch: 100,
      entryPoint: entryPoint === 0xffffffff ? -1 : entryPoint,
      maxLevel,
      nodes,
      graphs,
    };

    return {
      indexData,
      quantizerData,
      metadata,
      contents,
      dimension,
    };
  }

  /**
   * 检查文件是否为有效的 ASVEC 文件
   * @param {string} filePath
   * @returns {boolean}
   */
  static isValid(filePath) {
    try {
      if (!existsSync(filePath)) {
        return false;
      }
      const buf = readFileSync(filePath);
      if (buf.length < HEADER_SIZE) {
        return false;
      }
      const magic = buf.toString('ascii', 0, 5);
      return magic === MAGIC;
    } catch {
      return false;
    }
  }
}

export { MAGIC, VERSION, HEADER_SIZE, FLAG_HAS_QUANTIZER, FLAG_HAS_HNSW_GRAPH, FLAG_SQ8_VECTORS };
