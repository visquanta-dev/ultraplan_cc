import Link from 'next/link';
import { getAllPosts } from '../../lib/blog/get-posts';

export const dynamic = 'force-dynamic';

export default function BlogListPage() {
  const posts = getAllPosts();

  return (
    <main className="max-w-4xl mx-auto px-6 py-12">
      <div className="mb-12">
        <h1 className="text-4xl font-bold tracking-tight mb-2">UltraPlan Blog Preview</h1>
        <p className="text-gray-500">{posts.length} drafts generated</p>
      </div>

      <div className="space-y-8">
        {posts.map((post) => (
          <article key={post.file} className="border-b border-gray-200 pb-8">
            <Link href={`/blog/${encodeURIComponent(post.file)}`} className="group">
              <div className="flex items-center gap-3 mb-2">
                <span className="text-xs font-medium uppercase tracking-wider text-orange-600 bg-orange-50 px-2 py-0.5 rounded">
                  {post.category.title}
                </span>
                <span className="text-xs text-gray-400">{post.publishedAt}</span>
                <span className="text-xs text-gray-400">{post.wordCount} words</span>
              </div>
              <h2 className="text-2xl font-semibold group-hover:text-orange-600 transition-colors mb-2">
                {post.title}
              </h2>
              <p className="text-gray-600 line-clamp-2">{post.metaDescription}</p>
            </Link>
          </article>
        ))}

        {posts.length === 0 && (
          <p className="text-gray-400 text-center py-20">
            No drafts yet. Run <code className="bg-gray-100 px-1 rounded">npx tsx scripts/generate-local.ts</code> to generate posts.
          </p>
        )}
      </div>
    </main>
  );
}
