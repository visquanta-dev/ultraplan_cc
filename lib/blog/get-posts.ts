import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';

export interface BlogPost {
  slug: string;
  title: string;
  metaDescription: string;
  publishedAt: string;
  category: { slug: string; title: string };
  author: string;
  content: string;
  wordCount: number;
  file: string;
}

const DRAFTS_DIR = path.join(process.cwd(), 'tmp', 'drafts');

export function getAllPosts(): BlogPost[] {
  if (!fs.existsSync(DRAFTS_DIR)) return [];

  return fs.readdirSync(DRAFTS_DIR)
    .filter(f => f.endsWith('.md'))
    .map(file => {
      const raw = fs.readFileSync(path.join(DRAFTS_DIR, file), 'utf-8');
      const { data, content } = matter(raw);
      return {
        slug: data.slug ?? file.replace('.md', ''),
        title: data.title ?? 'Untitled',
        metaDescription: data.metaDescription ?? '',
        publishedAt: data.publishedAt ?? '',
        category: data.category ?? { slug: 'article', title: 'Article' },
        author: data.author ?? 'VisQuanta Team',
        content,
        wordCount: content.split(/\s+/).filter(Boolean).length,
        file,
      };
    })
    .sort((a, b) => b.file.localeCompare(a.file));
}

export function getPostByFile(file: string): BlogPost | null {
  const posts = getAllPosts();
  return posts.find(p => p.file === file) ?? null;
}
