import { File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';

import { CA_F_14 } from '@/features/consent/data/caF14';
import { CA_F_15 } from '@/features/consent/data/caF15';
import { CA_F_35 } from '@/features/consent/data/caF35';
import { parseConsentTemplate } from '@/features/consent/services/templateSchema';
import type { ConsentTemplate } from '@/features/consent/types/consent';
import { getJson } from '@/services/apiClient';
import { apiConfig, resolvePath } from '@/services/api/config';

/**
 * Consent templates, downloaded from the backend (published to AWS with
 * `API GATEWAY/scripts/publish-template.mjs`). A new or updated form reaches
 * the tablets without rebuilding the APK.
 *
 * Three sources, in order:
 *   1. remote   — GET /templates, then each form by code + version
 *   2. cache    — the last successful download, saved on the device, so the
 *                 tablet keeps working without internet
 *   3. bundled  — the forms shipped in the APK (data/caF*.ts), for a tablet never yet online
 *
 * Published versions never change, so a version already in the cache is not
 * downloaded again. Every template still goes through `parseConsentTemplate`;
 * one this app version cannot render (a newer block type, say) is skipped
 * instead of breaking the list.
 */

const BUNDLED: readonly unknown[] = [CA_F_14, CA_F_15, CA_F_35];
const CACHE_FILE = 'templates-cache.json';

export type TemplateSource = 'remote' | 'cache' | 'bundled';

/** Lightweight row for the picker. */
export type ConsentTemplateSummary = {
  code: string;
  version: string;
  title: string;
  effectiveDate: string;
  examType?: string;
};

type Catalog = { templates: ConsentTemplate[]; source: TemplateSource; savedAt: string | null };

type RemoteList = { templates: { code: string; version: string }[] };
type RemoteTemplate = { template: unknown; sha256: string };

let memory: Catalog | null = null;

function parseAll(raws: readonly unknown[]): ConsentTemplate[] {
  const out: ConsentTemplate[] = [];
  for (const raw of raws) {
    try {
      out.push(parseConsentTemplate(raw));
    } catch (err) {
      console.warn('[templates] plantilla ignorada:', err instanceof Error ? err.message : err);
    }
  }
  return out;
}

function cacheFile(): File | null {
  return Platform.OS === 'web' ? null : new File(Paths.document, CACHE_FILE);
}

function readCache(): { templates: ConsentTemplate[]; savedAt: string } | null {
  const file = cacheFile();
  if (!file?.exists) return null;
  try {
    const stored = JSON.parse(file.textSync()) as { templates: unknown[]; savedAt: string };
    return { templates: parseAll(stored.templates ?? []), savedAt: stored.savedAt };
  } catch {
    return null;
  }
}

function writeCache(templates: ConsentTemplate[], savedAt: string) {
  const file = cacheFile();
  if (!file) return;
  try {
    if (!file.exists) file.create();
    file.write(JSON.stringify({ templates, savedAt }));
  } catch (err) {
    console.warn('[templates] no se pudo guardar la copia local:', err);
  }
}

/** The active catalog from the backend, or null if any part of it could not be fetched. */
async function fetchRemote(): Promise<ConsentTemplate[] | null> {
  const list = await getJson<RemoteList>(apiConfig.paths.templates, { label: 'TEMPLATES' });
  if (list.status !== 'sent' || !Array.isArray(list.data?.templates)) return null;

  const cached = readCache()?.templates ?? [];
  const raws: unknown[] = [];
  for (const entry of list.data.templates) {
    const hit = cached.find((t) => t.code === entry.code && t.version === entry.version);
    if (hit) {
      raws.push(hit);
      continue;
    }
    const path = `${resolvePath(apiConfig.paths.template, { code: entry.code })}?version=${encodeURIComponent(entry.version)}`;
    const res = await getJson<RemoteTemplate>(path, { label: `TEMPLATE · ${entry.code} v${entry.version}` });
    // Half a catalog is worse than the last complete one: give up and use the cache.
    if (res.status !== 'sent') return null;
    raws.push(res.data.template);
  }
  return parseAll(raws);
}

async function load(): Promise<Catalog> {
  const remote = await fetchRemote();
  if (remote) {
    const savedAt = new Date().toISOString();
    writeCache(remote, savedAt);
    memory = { templates: remote, source: 'remote', savedAt };
    return memory;
  }
  const cached = readCache();
  if (cached) {
    memory = { templates: cached.templates, source: 'cache', savedAt: cached.savedAt };
    return memory;
  }
  memory = { templates: parseAll(BUNDLED), source: 'bundled', savedAt: null };
  return memory;
}

/** Refreshes from the backend every time the picker opens. */
export async function listConsentTemplates(): Promise<ConsentTemplateSummary[]> {
  const { templates } = await load();
  return templates
    .map(({ code, version, title, effectiveDate, examType }) => ({ code, version, title, effectiveDate, examType }))
    .sort((a, b) => a.code.localeCompare(b.code));
}

/** Where the list on screen came from, for the "sin conexión" notice. */
export function templateCatalogSource(): { source: TemplateSource; savedAt: string | null } | null {
  return memory ? { source: memory.source, savedAt: memory.savedAt } : null;
}

/**
 * The form to sign. Taken from what the picker just loaded, so the template
 * cannot change under a patient mid-signature.
 */
export async function getConsentTemplate(code: string): Promise<ConsentTemplate | null> {
  const catalog = memory ?? (await load());
  return catalog.templates.find((template) => template.code === code) ?? null;
}
