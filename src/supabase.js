import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Called immediately when a job is created — persists before any processing starts
export async function createJobRecord({ slug, name, sourceUrl }) {
  const domain = new URL(sourceUrl).hostname.replace(/^www\./, '');
  const { error } = await supabase.from('sites').upsert({
    id: slug,
    business_name: name || domain,
    owner_email: 'publishing@zing-work.com',
    status: 'migrating',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }, { onConflict: 'id' });
  if (error) throw error;
}

// Called on job completion
export async function completeJobRecord({ slug, previewUrl }) {
  const { error } = await supabase.from('sites').update({
    status: 'draft',
    preview_url: previewUrl || null,
    updated_at: new Date().toISOString(),
  }).eq('id', slug);
  if (error) throw error;
}

// Called on job error
export async function failJobRecord({ slug, errorMsg }) {
  const { error } = await supabase.from('sites').update({
    status: 'migration-error',
    updated_at: new Date().toISOString(),
  }).eq('id', slug);
  if (error) throw error;
}
