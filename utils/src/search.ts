import type { Bbox, Point, SearchResult, ZoomLevel } from "facilmap-types";
import throttle from "p-throttle";
import type { Geometry } from "geojson";
import { formatCoordinates } from "./format.js";
import { fetchAdapter, getConfig } from "./config.js";
import { getI18n } from "./i18n.js";
import { parseGpsCoordinates } from "parse-gps-coordinates";
import type { AnalyzedChangeset } from "./osm/changeset.js";
import { validateResponse, type OnProgress } from "./utils.js";
import type { OsmFeatureBlame } from "./osm/feature-blame";

interface NominatimResult {
	place_id: number;
	license: string;
	osm_type: "node" | "way" | "relation";
	osm_id: number;
	boundingbox: [string, string, string, string];
	lat: string;
	lon: string;
	zoom?: number;
	name: string;
	display_name: string;
	place_rank: number;
	category: string;
	type: string;
	addresstype: string;
	importance: number;
	icon: string;
	address: Partial<Record<string, string>>;
	geojson: Geometry;
	extratags: Record<string, string>;
	namedetails: Record<string, string> | null;
}

interface NominatimError {
	error: { code?: number; message: string } | string;
}

const limit = 25;
const stateAbbr: Record<string, Record<string, string>> = {
	"us" : {
		"alabama":"AL","alaska":"AK","arizona":"AZ","arkansas":"AR","california":"CA","colorado":"CO","connecticut":"CT",
		"delaware":"DE","florida":"FL","georgia":"GA","hawaii":"HI","idaho":"ID","illinois":"IL","indiana":"IN","iowa":"IA",
		"kansas":"KS","kentucky":"KY","louisiana":"LA","maine":"ME","maryland":"MD","massachusetts":"MA","michigan":"MI",
		"minnesota":"MN","mississippi":"MS","missouri":"MO","montana":"MT","nebraska":"NE","nevada":"NV","new hampshire":"NH",
		"new jersey":"NJ","new mexico":"NM","new york":"NY","north carolina":"NC","north dakota":"ND","ohio":"OH","oklahoma":"OK",
		"oregon":"OR","pennsylvania":"PA","rhode island":"RI","south carolina":"SC","south dakota":"SD","tennessee":"TN",
		"texas":"TX","utah":"UT","vermont":"VT","virginia":"VA","washington":"WA","west virginia":"WV","wisconsin":"WI","wyoming":"WY"
	},
	"it" : {
		"agrigento":"AG","alessandria":"AL","ancona":"AN","aosta":"AO","arezzo":"AR","ascoli piceno":"AP","asti":"AT",
		"avellino":"AV","bari":"BA","barletta":"BT","barletta-andria-trani":"BT","belluno":"BL","benevento":"BN",
		"bergamo":"BG","biella":"BI","bologna":"BO","bolzano":"BZ","brescia":"BS","brindisi":"BR","cagliari":"CA",
		"caltanissetta":"CL","campobasso":"CB","carbonia-iglesias":"CI","caserta":"CE","catania":"CT","catanzaro":"CZ",
		"chieti":"CH","como":"CO","cosenza":"CS","cremona":"CR","crotone":"KR","cuneo":"CN","enna":"EN","fermo":"FM",
		"ferrara":"FE","firenze":"FI","foggia":"FG","forli-cesena":"FC","frosinone":"FR","genova":"GE","gorizia":"GO",
		"grosseto":"GR","imperia":"IM","isernia":"IS","la spezia":"SP","l'aquila":"AQ","latina":"LT","lecce":"LE",
		"lecco":"LC","livorno":"LI","lodi":"LO","lucca":"LU","macerata":"MC","mantova":"MN","massa e carrara":"MS",
		"matera":"MT","medio campidano":"VS","messina":"ME","milano":"MI","modena":"MO","monza e brianza":"MB",
		"napoli":"NA","novara":"NO","nuoro":"NU","ogliastra":"OG","olbia-tempio":"OT","oristano":"OR","padova":"PD",
		"palermo":"PA","parma":"PR","pavia":"PV","perugia":"PG","pesaro e urbino":"PU","pescara":"PE","piacenza":"PC",
		"pisa":"PI","pistoia":"PT","pordenone":"PN","potenza":"PZ","prato":"PO","ragusa":"RG","ravenna":"RA",
		"reggio calabria":"RC","reggio emilia":"RE","rieti":"RI","rimini":"RN","roma":"RM","rovigo":"RO","salerno":"SA",
		"sassari":"SS","savona":"SV","siena":"SI","siracusa":"SR","sondrio":"SO","taranto":"TA","teramo":"TE","terni":"TR",
		"torino":"TO","trapani":"TP","trento":"TN","treviso":"TV","trieste":"TS","udine":"UD","varese":"VA","venezia":"VE",
		"verbano":"VB","verbano-cusio-ossola":"VB","vercelli":"VC","verona":"VR","vibo valentia":"VV","vicenza":"VI","viterbo":"VT"
	},
	"ca" : {
		"ontario":"ON","quebec":"QC","nova scotia":"NS","new brunswick":"NB","manitoba":"MB","british columbia":"BC",
		"prince edward island":"PE","saskatchewan":"SK","alberta":"AB","newfoundland and labrador":"NL"
	},
	"au" : {
		"australian capital territory":"ACT","jervis bay territory":"JBT","new south wales":"NSW","northern territory":"NT",
		"queensland":"QLD","south australia":"SA","tasmania":"TAS","victoria":"VIC","western australia":"WA"
	}
};

interface PointWithZoom extends Point {
	zoom?: ZoomLevel;
}

// Respect Nominatim rate limit (https://operations.osmfoundation.org/policies/nominatim/)
const throttledFetch = throttle({ limit: 1, interval: 1000 })((...args: Parameters<typeof fetchAdapter>) => fetchAdapter(...args));

type DecodedGeoQuery = Point & { zoom: number };

/**
 * Checks whether the given query string is a representation of coordinates, such an OSM permalink.
 */
export function decodeLonLatUrl(query: string): DecodedGeoQuery | undefined {
	query = query.replace(/^\s+/, "").replace(/\s+$/, "");
	let query_match: RegExpMatchArray | null, query_match2: DecodedGeoQuery | undefined;
	if(query_match = query.match(/^http:\/\/(www\.)?osm\.org\/go\/([-A-Za-z0-9_@]+)/))
	{ // Coordinates, shortlink
		return decodeShortLink(query_match[2]);
	}

	function decodeQueryString(str: string) {
		let lonMatch,latMatch,leafletMatch;

		if((lonMatch = str.match(/[?&]lon=([^&]+)/)) && (latMatch = str.match(/[?&]lat=([^&]+)/))) {
			return {
				lat: Number(decodeURIComponent(latMatch[1])),
				lon: Number(decodeURIComponent(lonMatch[1])),
				zoom: 15
			};
		}

		if(leafletMatch = str.match(/(^|=)(\d+)\/(-?\d+(\.\d+)?)\/(-?\d+(\.\d+)?)(&|\/|$)/)) {
			return {
				lat: Number(leafletMatch[3]),
				lon: Number(leafletMatch[5]),
				zoom: Number(leafletMatch[2])
			};
		}
	}

	if((query_match = query.match(/^https?:\/\/.*#(.*)$/)) && (query_match2 = decodeQueryString(query_match[1]))) {
		return query_match2;
	}

	if((query_match = query.match(/^https?:\/\/.*\?([^#]*)/)) && (query_match2 = decodeQueryString(query_match[1]))) {
		return query_match2;
	}

	return undefined;
}


const shortLinkCharArray = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_@";

/**
 * Decodes a string from FacilMap.Util.encodeShortLink().
*/
export function decodeShortLink(encoded: string): DecodedGeoQuery | undefined {
	const m = encoded.match(/^([A-Za-z0-9_@]+)/);
	if(!m) return undefined;
	const zoom = m[1].length*2+encoded.length-11;

	let c1 = 0;
	let c2 = 0;
	for(let i=0,j=54; i<m[1].length; i++,j-=6)
	{
		const bits = shortLinkCharArray.indexOf(m[1].charAt(i));
		if(j <= 30)
			c1 |= bits >>> (30-j);
		else if(j > 30)
			c1 |= bits << (j-30);
		if(j < 30)
			c2 |= (bits & (0x3fffffff >>> j)) << j;
	}

	let x = 0;
	let y = 0;

	for(let j=29; j>0;)
	{
		x = (x << 1) | ((c1 >> j--) & 1);
		y = (y << 1) | ((c1 >> j--) & 1);
	}
	for(let j=29; j>0;)
	{
		x = (x << 1) | ((c2 >> j--) & 1);
		y = (y << 1) | ((c2 >> j--) & 1);
	}

	x *= 4; // We can’t do <<= 2 here as x and y may be greater than 2³¹ and then the value would become negative
	y *= 4;

	const lon = x*90.0/(1<<30)-180.0;
	const lat = y*45.0/(1<<30)-90.0;

	return {
		lat : Math.round(lat*100000)/100000,
		lon: Math.round(lon*100000)/100000,
		zoom : zoom
	};
}

export function isSearchId(string: string | undefined): boolean {
	return !!string?.match(/^[nwr]\d+$/i);
}

/**
 * If the search query is a URL for which this is supported, loads the content of the URL through a direct fetch request.
 * Otherwise returns undefined.
 */
export async function loadDirectUrlQuery(query: string, onProgress?: OnProgress & { onBbox?: (bbox: Bbox) => void }): Promise<string | AnalyzedChangeset | OsmFeatureBlame | undefined> {
	query = query.trim();

	let m = query.match(/^(node|way|relation)\s+(\d+)$/);
	if (m) {
		return await fetch(`https://api.openstreetmap.org/api/0.6/${m[1]}/${m[2]}${m[1] != "node" ? "/full" : ""}`).then(validateResponse).then((res) => res.text());
	}

	m = query.match(/^trace\s+(\d+)$/);
	if (m) {
		return await fetch(`https://www.openstreetmap.org/trace/${m[1]}/data`).then(validateResponse).then((res) => res.text());
	}

	m = query.match(/^changeset\s+(\d+)$/);
	if (m) {
		const { analyzeChangeset } = await import("./osm/changeset");
		return await analyzeChangeset(Number(m[1]), onProgress);
	}

	m = query.match(/^blame\s+(way|relation)\s+(\d+)$/);
	if (m) {
		const { blameOsmFeature } = await import("./osm/feature-blame");
		return await blameOsmFeature(m[1] as "way" | "relation", Number(m[2]), onProgress);
	}
}

/**
 * If the search query is represents a URL, returns that URL. Otherwise returns undefined.
 */
export function parseUrlQuery(query: string): string | undefined {
	query = query.trim();

	if(query.match(/^https?:\/\//))
		return query;
}

type FindOptions = { lang?: string };

export async function find(query: string, options: FindOptions = {}): Promise<Array<SearchResult>> {
	query = query.replace(/^\s+/, "").replace(/\s+$/, "");

	const lonlat_match = parseGpsCoordinates(query);
	if(lonlat_match) {
		const result = await _findLonLat(lonlat_match, options);
		return result.map((res) => ({ ...res, id: query }));
	}

	const osm_match = query.match(/^([nwr])(\d+)$/i);
	if(osm_match)
		return await _findOsmObject(osm_match[1], osm_match[2], options);

	return await _findQuery(query, options);
}

export function getFallbackLonLatResult(pointWithZoom: PointWithZoom): SearchResult {
	const name = formatCoordinates(pointWithZoom);
	return {
		lat: pointWithZoom.lat,
		lon: pointWithZoom.lon,
		type: "coordinates",
		short_name: name,
		display_name: name,
		zoom: pointWithZoom.zoom != null ? pointWithZoom.zoom : 15,
		icon: undefined
	};
}

async function _findLonLat(lonlatWithZoom: PointWithZoom, options: FindOptions = {}): Promise<Array<SearchResult>> {
	const res = await throttledFetch(
		`${getConfig().nominatimUrl}/reverse?${new URLSearchParams({
			format: "jsonv2",
			addressdetails: "1",
			polygon_geojson: "0",
			extratags: "1",
			namedetails: "1",
			lat: `${lonlatWithZoom.lat}`,
			lon: `${lonlatWithZoom.lon}`,
			zoom: `${lonlatWithZoom.zoom != null ? (lonlatWithZoom.zoom >= 12 ? lonlatWithZoom.zoom+2 : lonlatWithZoom.zoom) : 17}`,
			...options.lang ? { "accept-language": options.lang } : {}
		})}`
	);

	if (!res.ok) {
		throw new Error(getI18n().t("search.http-error", { status: res.status }));
	}

	const body: NominatimResult | NominatimError = await res.json();

	if("error" in body) {
		throw new Error(typeof body.error === 'string' ? body.error : body.error.message);
	}

	body.lat = `${lonlatWithZoom.lat}`;
	body.lon = `${lonlatWithZoom.lon}`;
	body.zoom = lonlatWithZoom.zoom || 15;

	return [ _prepareSearchResult(body) ];
}

async function _findQuery(query: string, options: FindOptions = {}): Promise<Array<SearchResult>> {
	const res = await throttledFetch(
		`${getConfig().nominatimUrl}/search?${new URLSearchParams({
			format: "jsonv2",
			polygon_geojson: "1",
			addressdetails: "1",
			namedetails: "1",
			limit: `${limit}`,
			extratags: "1",
			q: query,
			...options.lang ? { "accept-language": options.lang } : {}
		})}`
	);

	if (!res.ok) {
		throw new Error(getI18n().t("search.http-error", { status: res.status }));
	}

	const body: Array<NominatimResult> | NominatimError = await res.json();

	if ('error' in body) {
		throw new Error(typeof body.error === 'string' ? body.error : body.error.message);
	}


	return body.map(_prepareSearchResult);
}

async function _findOsmObject(type: string, id: string, options: FindOptions = {}): Promise<Array<SearchResult>> {
	const res = await throttledFetch(
		`${getConfig().nominatimUrl}/lookup?${new URLSearchParams({
			format: "jsonv2",
			addressdetails: "1",
			polygon_geojson: "1",
			extratags: "1",
			namedetails: "1",
			osm_ids: `${type.toUpperCase()}${encodeURI(id)}`,
			...options.lang ? { "accept-language": options.lang } : {}
		})}`
	);

	if (!res.ok) {
		throw new Error(getI18n().t("search.http-error", { status: res.status }));
	}

	const body: Array<NominatimResult> | NominatimError = await res.json();

	if('error' in body)
		throw new Error(typeof body.error === 'string' ? body.error : body.error.message);

	return body.map(_prepareSearchResult);
}

function _prepareSearchResult(result: NominatimResult): SearchResult {
	const { address, nameWithAddress, name } = _formatAddress(result);
	return {
		short_name: name,
		display_name: nameWithAddress,
		address,
		boundingbox: result.boundingbox?.map((n) => Number(n)) as [number, number, number, number],
		lat: Number(result.lat),
		lon: Number(result.lon),
		zoom: result.zoom,
		extratags: {
			[result.category]: result.type,
			...result.extratags
		},
		geojson: result.geojson,
		icon: result.icon && result.icon.replace(/^.*\/([a-z0-9_]+)\.[a-z0-9]+\.[0-9]+\.[a-z0-9]+$/i, "$1"),
		type: result.addresstype,
		id: result.osm_id ? result.osm_type.charAt(0) + result.osm_id : undefined
	};
}

/**
 * Tries to format a search result in a readable way according to the address notation habits in
 * the appropriate country.
 * @param result {Object} A place object as returned by Nominatim
 * @return {Object} An object with address, nameWithAddress and name strings
 */
function _formatAddress(result: NominatimResult) {
	// See http://en.wikipedia.org/wiki/Address_%28geography%29#Mailing_address_format_by_country for
	// address notation guidelines

	let type = result.addresstype;
	let name = result.namedetails?.name ?? result.name;
	const countryCode = result.address.country_code;

	let road = result.address.road;
	const housenumber = result.address.house_number;
	const suburbType = ["town", "suburb", "village", "hamlet", "residential"].find((t) => !!result.address[t]);
	let suburb = suburbType && result.address[suburbType];
	const postcode = result.address.postcode;
	let city = result.address.city;
	let county = result.address.county;
	let state = result.address.state;
	const country = result.address.country;

	if(["road", suburbType, "city", "county", "state", "country"].includes(type))
		name = "";

	if(!city && suburb) {
		city = suburb;
		suburb = "";
	}

	if(road) {
		switch(countryCode) {
			case "pl":
				road = "ul. "+road;
				break;
		}
	}

	// Add house number to road
	if(road && housenumber) {
		switch(countryCode) {
			case "ar":
			case "at":
			case "ca":
			case "de":
			case "hr":
			case "cz":
			case "dk":
			case "fi":
			case "is":
			case "il":
			case "it":
			case "nl":
			case "no":
			case "pe":
			case "pl":
			case "sk":
			case "si":
			case "se":
			case "tr":
				road += " "+housenumber;
				break;
			case "be":
			case "es":
				road += ", "+housenumber;
				break;
			case "cl":
				road += " N° "+housenumber;
				break;
			case "hu":
				road += " "+housenumber+".";
				break;
			case "id":
				road += " No. "+housenumber;
				break;
			case "my":
				road = "No." +housenumber+", "+road;
				break;
			case "ro":
				road += ", nr. "+housenumber;
				break;
			case "au":
			case "fr":
			case "hk":
			case "ie":
			case "in":
			case "nz":
			case "sg":
			case "lk":
			case "tw":
			case "gb":
			case "us":
			default:
				road = housenumber+" "+road;
				break;
		}
	}

	// Add postcode and districts to city
	switch(countryCode) {
		case "ar":
			if(postcode && city)
				city = postcode+", "+city;
			else if(postcode)
				city = postcode;
			break;
		case "at":
		case "ch":
		case "de":
			if(city) {
				if(suburb)
					city += "-"+(suburb);
				suburb = undefined;
				if(type == "suburb" || type == "residential")
					type = "city";

				if(postcode)
					city = postcode+" "+city;
			} else if (postcode)
				city = postcode;
			break;
		case "be":
		case "hr":
		case "cz":
		case "dk":
		case "fi":
		case "fr":
		case "hu":
		case "is":
		case "il":
		case "my":
		case "nl":
		case "no":
		case "sk":
		case "si":
		case "es":
		case "se":
		case "tr":
			if(city && postcode)
				city = postcode+" "+city;
			else if (postcode)
				city = postcode;
			break;
		case "au":
		case "ca":
		case "us":
			if(city && state)
			{
				const thisStateAbbr = stateAbbr[countryCode][state.toLowerCase()];
				if(thisStateAbbr)
				{
					city += " "+thisStateAbbr;
					state = undefined;
				}
			}
			if(city && postcode)
				city += " "+postcode;
			else if(postcode)
				city = postcode;
			break;
		case "it":
			if(city)
			{
				if(county)
				{
					const countyAbbr = stateAbbr.it[county.toLowerCase().replace(/ì/g, "i")];
					if(countyAbbr)
					{
						city += " ("+countyAbbr+")";
						county = undefined;
					}
				}
				if(postcode)
					city  = postcode+" "+city;
			} else if (postcode)
				city = postcode;
			break;
		case "ro":
			if(city && county)
			{
				city += ", jud. "+county;
				county = undefined;
			}
			if(city && postcode)
				city += ", "+postcode;
			else if (postcode)
				city = postcode;
			break;
		case "cl":
		case "hk": // Postcode rarely/not used
		case "ie":
		case "in":
		case "id":
		case "nz":
		case "pe":
		case "sg":
		case "lk":
		case "tw":
		case "gb":
		default:
			if(city && postcode)
				city = city+" "+postcode;
			else if(postcode)
				city = postcode;
			break;
	}

	const address = [ ];

	if(road)
		address.push(road);
	if(suburb)
		address.push(suburb);
	if(city)
		address.push(city);
	if(["residential", "town", "suburb", "village", "hamlet", "residential", "city", "county", "state"].includes(type) || address.length == 0)
	{ // Searching for a town
		if(county && county != city)
			address.push(county);
		if(state && state != city)
			address.push(state);
	}

	if(country)
		address.push(country);

	const fullName = [ ...address ];
	if(name && name != address[0])
		fullName.unshift(name);

	return {
		address: address.join(", "),
		nameWithAddress: fullName.join(", "),
		name: fullName[0]
	};
}