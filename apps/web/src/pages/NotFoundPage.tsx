import { SearchX } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";

export function NotFoundPage() {
  return (
    <div className="rounded-md border border-border bg-surface">
      <EmptyState
        icon={SearchX}
        title="Página no encontrada."
        description="La dirección que buscas no existe en este sitio."
        action={
          <Link to="/">
            <Button variant="ghost">Volver al ranking</Button>
          </Link>
        }
      />
    </div>
  );
}
