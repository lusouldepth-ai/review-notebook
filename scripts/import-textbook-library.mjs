import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createTextbookStore,
  inferTextbookMetadataFromFilename
} from '../server/textbook-store.mjs';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const store = createTextbookStore({ rootDir: path.join(projectRoot, 'data', 'textbooks') });
async function listSupportedFiles(rootDir) {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(rootDir, entry.name);
      if (entry.isDirectory()) return listSupportedFiles(fullPath);
      return /\.(pdf|txt|md)$/i.test(entry.name) ? [fullPath] : [];
    })
  );
  return nested.flat().sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

function parseSource(value) {
  const separatorIndex = value.indexOf('=');
  if (separatorIndex < 1) return null;
  return {
    subject: value.slice(0, separatorIndex).trim(),
    rootDir: path.resolve(value.slice(separatorIndex + 1).trim())
  };
}

const sources = process.argv.slice(2).map(parseSource).filter(Boolean);
if (sources.length === 0) {
  console.error('用法：npm run import:textbooks -- "数学=/教材/数学" "语文=/教材/语文"');
  process.exitCode = 1;
} else {
  let imported = 0;
  const failures = [];
  for (const source of sources) {
    const files = await listSupportedFiles(source.rootDir);
    for (const sourcePath of files) {
      const filename = path.basename(sourcePath);
      const metadata = inferTextbookMetadataFromFilename(filename, source.subject);
      if (!metadata.grade) {
        failures.push({ filename, error: '文件名中未识别到一年级至六年级' });
        continue;
      }
      const result = await store.importSystemFile({
        ...metadata,
        sourcePath
      });
      if (result.ok) {
        imported += 1;
        console.log(`已导入 ${metadata.subject} ${metadata.grade}${metadata.semester}：${filename}`);
      } else {
        failures.push({ filename, error: result.error });
      }
    }
  }

  console.log(`教材导入完成：成功 ${imported} 本，失败 ${failures.length} 本。`);
  failures.forEach((item) => console.error(`失败 ${item.filename}：${item.error}`));
  if (failures.length > 0) process.exitCode = 1;
}
