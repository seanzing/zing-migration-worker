import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export async function createSiteRecord({ slug, name, sourceUrl }) {
  const domain = new URL(sourceUrl).hostname.replace(/^www\./, '');
  const { error } = await supabase.from('sites').upsert({
    id: slug,
    business_name: name || domain,
    owner_email: 'publishing@zing-work.com',
    status: 'draft',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }, { onConflict: 'id' });
  if (error) throw error;
}
