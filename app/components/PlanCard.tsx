import type { PlanResponse } from "../../shared/contract";

// The suggested bus, in big text for low-vision riders and helpers.
// heard: what speech recognition heard, so a mishearing is visible to a helper.
export default function PlanCard({ plan, heard }: { plan: PlanResponse; heard: string }) {
  return (
    <section className="card" aria-label="Санал болгосон автобус">
      {heard && <p className="heard">Сонссон: “{heard}”</p>}
      <p>
        Очих: <strong>{plan.destination.name}</strong>
      </p>
      <p className="route">{plan.route}</p>
      <p>
        Суух: <strong>{plan.board_stop.name}</strong> ({plan.board_stop.distance_m} м)
      </p>
      <p>
        Буух: <strong>{plan.alight_stop.name}</strong> ({plan.stops_to_ride} зогсоол)
      </p>
    </section>
  );
}
