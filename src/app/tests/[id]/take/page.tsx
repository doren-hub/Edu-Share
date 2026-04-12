import { createClient } from "@/lib/supabase/server";
import TakeQuiz from "./TakeQuiz";

export default async function TakePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return <TakeQuiz testId={id} initialIsAuthed={!!user} />;
}
