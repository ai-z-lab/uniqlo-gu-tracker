// Supabase connection info for the (read-only) public frontend.
// This is the "publishable" key, which is safe to expose in client-side
// code — it can only read rows allowed by price_events' RLS policy
// (public SELECT) and cannot write anything. Never put the service_role
// key here.
export const SUPABASE_URL = "https://noiipcsglzhsdjrgjpet.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_kcojtiaRcFUEiblIz3NjqQ_Sf4NC1EN";
