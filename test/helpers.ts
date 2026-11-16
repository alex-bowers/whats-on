// Builders for pages shaped like the real sites, used to drive the scrapers and a whole sync run.

export interface FakeAtgShow {
  path: string; // "legally-blonde/regent-theatre"
  title: string;
  dates: string;
  venue?: string;
  genre?: string;
  infoBar?: string;
  buy?: boolean;
}

/** An ATG listing page: the show cards inside Next.js page data, split across two chunks as on the live site. */
export function atgPage(shows: FakeAtgShow[], found: number): string {
  const cards = shows.map((s, i) => ({
    id: `show_${i}`,
    titleImage: { alt: "", images: { "375": { "1x": `https://img.example/375/${s.path}.jpg` }, "786": { "1x": `https://img.example/786/${s.path}.jpg` } } },
    title: s.title,
    dates: s.dates,
    infoBarText: s.infoBar ?? "",
    genre: [s.genre ?? "Concert"],
    venueInfo: s.venue ?? "Regent Theatre, Stoke-on-Trent",
    accessIcons: [],
    subTitle: "$undefined",
    moreInfo: { label: "More info", url: `/shows/${s.path}/` },
    buyTickets: s.buy === false ? "$undefined" : { label: "Buy tickets", url: `/shows/${s.path}/calendar/` },
  }));
  const data = `7:["$","div",null,{"id":"venue-tabpanel-whats-on","children":[["$","$L22",null,{"found":${found},"cards":${JSON.stringify(cards)},"currentPage":1}]]}]\n`;
  const half = Math.floor(data.length / 2);
  const push = (text: string) => `<script>self.__next_f.push([1,${JSON.stringify(text)}])</script>`;
  return `<!DOCTYPE html><html><body><p>${found} shows</p>${push('1:"$Sreact.fragment"\n')}${push(data.slice(0, half))}${push(data.slice(half))}</body></html>`;
}

export function atgDetail(o: { first: string; showTimes?: string[]; onSaleStart?: string; preSale?: string; min?: number }) {
  return {
    firstPerformanceDate: o.first,
    showTimes: o.showTimes ?? [],
    onSaleStartDate: o.onSaleStart ?? "",
    preSaleStarts: o.preSale ?? "",
    priceInfo: { min: o.min ?? 25, transactionFee: 0 },
    overview: "A show.",
    status: "onSale",
  };
}

export interface FakeProduction {
  slug: string;
  title: string;
  dates: string;
}

export function newVicPage(productions: FakeProduction[], next: string | null): string {
  const items = productions.map((p) => `<div class="col-xs-12 col-sm-6"> <a href="https://www.newvictheatre.org.uk/productions/${p.slug}/"> <figure class="feature"> <img src="https://www.newvictheatre.org.uk/wp-content/uploads/${p.slug}.jpg" alt=""> <figcaption><h2 class="contrast">${p.title}</h2></figcaption> </figure> </a> <div class="feature__content event"> <h2>${p.dates}</h2> <h3 class="uppercase">${p.title}</h3> <p>Summary of ${p.title}&hellip;</p> <a href="https://www.newvictheatre.org.uk/productions/${p.slug}/">Read more</a> </div> </div>`);
  const nav = next ? `<a class="next page-numbers" href="${next}">Next</a>` : "";
  return `<html><body>${items.join("")}<div class="pagination">${nav}</div></body></html>`;
}

/** A production page listing performances such as "Friday 13 November 2026, 19:30". */
export function newVicProduction(performances: string[]): string {
  const rows = performances.map((when, i) => `<div class="timeWrapper"> <div class="leftSide"> <div>${when}</div> </div> <div class="rightSide"> <a href="/choose-seats?link=https://tickets.newvictheatre.org.uk/newvictheatre/website/ChooseSeats.aspx?EventInstanceId=${1000 + i}&resize=true" class="button bookTickets">Book tickets</a> </div> </div>`);
  return `<html><body><p> <b>Tickets:</b> £20.00 - £30.00 <br> </p><section class="modal-content"><div class="timesWrapper"><div class="inner">${rows.join(" ")}</div></div></section></body></html>`;
}
