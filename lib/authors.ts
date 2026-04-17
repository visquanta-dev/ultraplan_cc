import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';

export interface Author {
  name: string;
  slug: string;
  title: string;
  short_title: string;
  company: string;
  photo: string;
  linkedin: string;
  author_page: string;
  credential_line: string;
  bio: string;
  lanes: string[];
}

interface AuthorsConfig {
  authors: Record<string, Author>;
  default_author: string;
}

const AUTHORS_YAML_PATH = path.join(process.cwd(), 'config', 'authors.yaml');

let cached: AuthorsConfig | null = null;

function load(): AuthorsConfig {
  if (cached) return cached;
  const raw = fs.readFileSync(AUTHORS_YAML_PATH, 'utf-8');
  cached = yaml.parse(raw) as AuthorsConfig;
  return cached;
}

export function getAuthor(slug: string): Author {
  const { authors, default_author } = load();
  return authors[slug] ?? authors[default_author];
}

export function getDefaultAuthor(): Author {
  const { authors, default_author } = load();
  return authors[default_author];
}

export function getDefaultAuthorSlug(): string {
  return load().default_author;
}

/**
 * Resolve an author slug for a post from its lane + tags.
 *
 * Today: always returns william-voyles because he's the only fully-populated
 * author. When Christopher / Aaron / Matt come online (photo + bio + linkedin
 * filled in), extend this to match their `lanes` list against the post's
 * tags + category slug.
 */
export function routeAuthorForPost(_input: {
  lane: string;
  tags: Array<{ slug: string }>;
  categorySlug?: string;
}): string {
  return getDefaultAuthorSlug();
}
