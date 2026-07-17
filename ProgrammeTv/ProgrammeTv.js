import fs from "fs";
import { XMLParser } from "fast-xml-parser";
import * as url from 'url';

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));
const XMLTV_FILE = __dirname + "/guide.xml";
const XMLTV_URL = "https://xmltvfr.fr/xmltv/xmltv_tnt.xml";

// On stocke les programmes groupés par chaîne pour un accès instantané
let XMLTV_INDEXED_PROGRAMS = new Map(); 

async function downloadXMLTV() {
    try {
        info("[ProgrammeTv] Téléchargement du guide TNT depuis xmltvfr.fr...");
        const response = await fetch(XMLTV_URL);

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const xmlText = await response.text();
        fs.writeFileSync(XMLTV_FILE, xmlText, "utf8");

        infoGreen("[ProgrammeTv] Nouveau fichier guide.xml enregistré avec succès.");
        return true;
    } catch (err) {
        error("[ProgrammeTv] Échec du téléchargement automatique :", err.message);
        return false;
    }
}

async function loadXMLTV() {
    try {
        let forceDownload = false;

        if (!fs.existsSync(XMLTV_FILE)) {
            forceDownload = true;
        } else {
            // Vérification de l'âge du fichier (si plus vieux que 24h, on retélécharge)
            const stats = fs.statSync(XMLTV_FILE);
            const now = new Date().getTime();
            const fileAgeMs = now - stats.mtime.getTime();
            const twentyFourHoursMs = 24 * 60 * 60 * 1000;

            if (fileAgeMs > twentyFourHoursMs) {
                info("[ProgrammeTv] Le guide local a plus de 24 heures. Mise à jour requise.");
                forceDownload = true;
            }
        }

        if (forceDownload) {
            const success = await downloadXMLTV();
            // Si le site est down, on tente quand même de lire le vieux fichier au lieu de planter
            if (!success && !fs.existsSync(XMLTV_FILE)) return false;
        }

        const xml = fs.readFileSync(XMLTV_FILE, "utf8");
        const parser = new XMLParser({
            ignoreAttributes: false,
            attributeNamePrefix: "",
            allowBooleanAttributes: true,
            textNodeName: "_text"
        });

        const parsed = parser.parse(xml);
        if (parsed) {
            const targetData = parsed.tv || parsed;
            const programsList = Array.isArray(targetData.programme) 
                ? targetData.programme 
                : (targetData.programme ? [targetData.programme] : []);

            const tempMap = new Map();
            for (const prog of programsList) {
                if (!prog.channel) continue;
                if (!tempMap.has(prog.channel)) {
                    tempMap.set(prog.channel, []);
                }
                tempMap.get(prog.channel).push(prog);
            }
            
            XMLTV_INDEXED_PROGRAMS = tempMap;
            infoGreen("[ProgrammeTv] XMLTV local chargé et indexé avec succès en mémoire globale.");
            return true;
        }
        return false;
    } catch (err) {
        error("[ProgrammeTv] Erreur parsing XMLTV local:", err.message);
        return false;
    }
}

export async function init() {
    await Avatar.lang.addPluginPak("ProgrammeTv");
    await loadXMLTV();
}
    
export async function action(data, callback) {
    try {
        const L = await Avatar.lang.getPak("ProgrammeTv", data.language);

        const tblActions = {
            getProgramme: () => handleProgramTv(data, data.client, L, callback)
        };

        info("ProgrammeTv:", data.action.command, "from", data.client);

        if (tblActions[data.action.command]) {
            await tblActions[data.action.command]();
        } else callback();

    } catch (err) {
        error("Erreur ProgrammeTv :", err.message);
        Avatar.speak("Une erreur est survenue avec le programme TV.", data.client, () => {
            Avatar.Speech.end(data.client);
            callback();
        });
    }
}

const handleProgramTv = async (data, client, L, callback) => {
    try {
        const sentence = data.rawSentence || data.action.sentence || "";
        const cleanText = (str) => str.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

        let rawSentence = cleanText(sentence);
        rawSentence = rawSentence.replace(/\bil y a quoi a la tele|\bquel sont les|\bprogramme tele/g, '').trim();

        const isNow = rawSentence.includes("maintenant") || rawSentence.includes("en ce moment");
        const period = isNow ? "now" : "night";

        const MAP = Config.modules.ProgrammeTv.CHANNELS_MAP || {};
        let targetChannel;

        for (const key of Object.keys(MAP)) {
            if (rawSentence.includes(cleanText(key))) {
                targetChannel = key; 
                break;
            }
        }

        if (targetChannel) {
            return await getProgrammeChannel(targetChannel, period, client, L, callback);
        }

        return await programmeGet(period, client, L, callback);

    } catch (err) {
        error("Erreur handleProgramTv:", err);
        throw err;
    }
};

// Version optimisée et plus rapide pour parser le format XMLTV (YYYYMMDDHHMMSS)
const parseXMLTVDate = (dateStr) => {
    if (!dateStr || dateStr.length < 14) return new Date(0);
    return new Date(
        `${dateStr.substring(0,4)}-${dateStr.substring(4,6)}-${dateStr.substring(6,8)}T${dateStr.substring(8,10)}:${dateStr.substring(10,12)}:${dateStr.substring(12,14)}`
    );
};

const parseXMLTVText = (field) => {
    if (!field) return "";
    if (typeof field === "string") return field;
    if (typeof field === "object") {
        if (field._text) return field._text;
        if (field.value) return field.value;
        if (Array.isArray(field)) return parseXMLTVText(field[0]);
    }
    return "";
};

// Calcule l'heure cible selon la période (maintenant ou ce soir à 21h10)
const getTargetTime = (period) => {
    const now = new Date();
    if (period === "night") {
        now.setHours(21, 10, 0, 0); // Force à ce soir 21h10
    }
    return now.getTime();
};

// Recherche du programme selon le moment cible (now ou ce soir)
const getCurrentProgram = (channelId, period) => {
    const programs = XMLTV_INDEXED_PROGRAMS.get(channelId);
    if (!programs) return null;

    const targetTime = getTargetTime(period); 
    return programs.find(p => { 
        const start = parseXMLTVDate(p.start).getTime(); 
        const stop = parseXMLTVDate(p.stop).getTime(); 
        return targetTime >= start && targetTime <= stop; 
    }) || null; 
};

const getProgrammeChannel = async (targetChannel, period, client, L, callback) => {
    try {
        const MAP = Config.modules.ProgrammeTv.CHANNELS_MAP || {};
        const channelId = MAP[targetChannel];
        const prog = getCurrentProgram(channelId, period); // Ajout de period ici

        if (!prog) {
            info(L.get("speech.noProgram", targetChannel));
            return Avatar.speak(L.get("speech.noProgram", targetChannel), client, () => {
                Avatar.Speech.end(client);
                callback();
            });
        }

        const title = parseXMLTVText(prog.title);
        const start = parseXMLTVDate(prog.start).toLocaleTimeString("fr-FR", {
            hour: "2-digit",
            minute: "2-digit"
        });

        const speech = L.get("speech.default", targetChannel.toUpperCase(), start, title);
        info(speech);

        Avatar.speak(speech, client, () => {
            Avatar.Speech.end(client);
            callback();
        });

    } catch (err) {
        error("[ProgrammeTv] Erreur getProgrammeChannel :", err.message);
        Avatar.speak(L.get("speech.errorFetch"), client, () => {
            Avatar.Speech.end(client);
            callback();
        });
    }
};

const programmeGet = async (period, client, L, callback) => {
    try {
        const MAP = Config.modules.ProgrammeTv.CHANNELS_MAP || {};
        const channelsKeys = Object.keys(MAP).slice(0, 6); 
        const speeches = [];

        for (const key of channelsKeys) {
            const channelId = MAP[key];
            const prog = getCurrentProgram(channelId, period); // Ajout de period ici
            if (!prog) continue;

            const title = parseXMLTVText(prog.title);
            const start = parseXMLTVDate(prog.start).toLocaleTimeString("fr-FR", {
                hour: "2-digit",
                minute: "2-digit"
            });

            speeches.push(L.get("speech.default", key.toUpperCase(), start, title));
        }

        if (!speeches.length) {
            info(L.get("speech.noProgram"));
            return Avatar.speak(L.get("speech.noProgram"), client, () => {
                Avatar.Speech.end(client);
                callback();
            });
        }

        const intro = period === "now" ? "En ce moment" : "Ce soir";
        const fullSpeech = `${intro}, ${speeches.join(", ")}`;

        info(fullSpeech);

        Avatar.speak(fullSpeech, client, () => {
            Avatar.Speech.end(client);
            callback();
        });

    } catch (err) {
        error("[ProgrammeTv] Erreur getProgramme global :", err.message);
        Avatar.speak(L.get("speech.errorFetch"), client, () => {
            Avatar.Speech.end(client);
            callback();
        });
    }
};
