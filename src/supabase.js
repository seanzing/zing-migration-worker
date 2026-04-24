import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export async function createSiteRecord({ slug, name, sourceUrl, previewUrl }) {
  const domain = new URL(sourceUrl).hostname.replace(/^www\./, '');
  const { error } = await supabase.from('sites').upsert({
    id: slug,
    business_name: name || domain,
    status: 'draft',
    preview_url: previewUrl || null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }, { onConflict: 'id' });
  if (error) throw error;
}

export async function updateSitePreviewUrl(slug, previewUrl) {
  const { error } = await supabase.from('sites')
    .update({ preview_url: previewUrl, updated_at: new Date().toISOString() })
    .eq('id', slug);
  if (error) throw error;
}
