import type { PlanResponse } from "../../shared/contract";
import { routeLabel } from "../lib/route";

// The suggested trip, in big text for low-vision riders and helpers: one bus, or two with a transfer.
// heard: what speech recognition heard, so a mishearing is visible to a helper.
// leg: 1 once the rider is on the second bus's part of the trip (its line is highlighted).
export default function PlanCard({ plan, heard, leg }: { plan: PlanResponse; heard: string; leg: number }) {
  const t = plan.transfer;
  return (
    <section className="card" aria-label="Санал болгосон автобус">
      {heard && <p className="heard">Сонссон: “{heard}”</p>}
      <p>
        Очих: <strong>{plan.destination.name}</strong>
      </p>
      <p className={t && leg === 1 ? "route done" : "route"}>
        {routeLabel(plan.route)}
        {t && <span className="route-then"> → {routeLabel(t.route)}</span>}
      </p>
      <p>
        Суух: <strong>{plan.board_stop.name}</strong> ({plan.board_stop.distance_m} м)
      </p>
      {t ? (
        <>
          <p>
            Дамжин суух: <strong>{plan.alight_stop.name}</strong> ({plan.stops_to_ride} зогсоол)
            {t.board_stop.distance_m > 0 && (
              <>
                {" "}→ <strong>{t.board_stop.name}</strong> ({t.board_stop.distance_m} м алхана)
              </>
            )}
          </p>
          <p>
            Буух: <strong>{t.alight_stop.name}</strong> ({t.stops_to_ride} зогсоол, {routeLabel(t.route)})
          </p>
        </>
      ) : (
        <p>
          Буух: <strong>{plan.alight_stop.name}</strong> ({plan.stops_to_ride} зогсоол)
        </p>
      )}
    </section>
  );
}
