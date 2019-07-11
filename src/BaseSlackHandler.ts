import { Logging } from "matrix-appservice-bridge";
import * as rp from "request-promise-native";

import { Main } from "./Main";
import { SlackGhost } from "./SlackGhost";
import { default as subs } from "./substitutions";

const log = Logging.get("BaseSlackHandler");

const CHANNEL_ID_REGEX = /<#(\w+)\|?\w*?>/g;
const CHANNEL_ID_REGEX_FIRST = /<#(\w+)\|?\w*?>/;

// (if the message is an emote, the format is <@ID|nick>, but in normal msgs it's just <@ID>
const USER_ID_REGEX = /<@(\w+)\|?\w*?>/g;
const USER_ID_REGEX_FIRST = /<@(\w+)\|?\w*?>/;

export const INTERNAL_ID_LEN = 32;
export const HTTP_CODES = {
    CLIENT_ERROR: 400,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    OK: 200,
    SERVER_ERROR: 500,
};

export interface ISlackMessage {
    channel: string;
    text?: string;
}

export interface ISlackFile {
    permalink_public: string;
    id: string;
    url_private: string;
    public_url_shared: string;
// tslint:disable-next-line: no-any
    _content: any;
    permalink: string;
}

export abstract class BaseSlackHandler {
    constructor(protected main: Main) { }

    public async getSlackRoomNameFromID(id: string, token: string) {
        const channelsInfoApiParams = {
            json: true,
            qs: {
                channel: id,
                token,
            },
            uri: "https://slack.com/api/channels.info",
        };
        this.main.incRemoteCallCounter("channels.info");
        try {
            const response = await rp(channelsInfoApiParams);
            if (response && response.channel && response.channel.name) {
                log.info(`channels.info: ${id} mapped to ${response.channel.name}`);
                return response.channel.name;
            }
            log.info("channels.info returned no result for " + id);

        } catch (err) {
            log.error("Caught error handling channels.info:" + err);
        }
        return id;
    }

    public async doChannelUserReplacements(msg: ISlackMessage, text: string, token: string) {
        text = (await this.replaceChannelIdsWithNames(msg, text, token))!;
        return await this.replaceUserIdsWithNames(msg, text, token);
    }

    public async replaceChannelIdsWithNames(message: ISlackMessage, text: string|undefined, token: string) {
        if (text === undefined) {
            return text;
        }
        const testForName = text.match(CHANNEL_ID_REGEX);
        let iteration = 0;
        let matches = 0;

        if (testForName && testForName.length) {
            matches = testForName.length;
        }

        while (iteration < matches) {
            // foreach channelId, pull out the ID
            // (if this is an emote msg, the format is <#ID|name>, but in normal msgs it's just <#ID>
            const id = testForName![iteration].match(CHANNEL_ID_REGEX_FIRST)![1];

            // Lookup the room in the store.
            let room = this.main.getRoomBySlackChannelId(id);

            // If we bridge the room, attempt to look up its canonical alias.
            if (room !== undefined) {
                const client = this.main.botIntent.getClient();
                const canonical = await client.getStateEvent(room.MatrixRoomId, "m.room.canonical_alias");
                if (canonical !== undefined && canonical.alias !== undefined) {
                    text = text.replace(CHANNEL_ID_REGEX_FIRST, canonical.alias);
                } else {
                    // If we can't find a canonical alias fall back to just the slack channel name.
                    room = undefined;
                }
            }

            // If we can't match the room then we just put the slack name
            if (room === undefined) {
                const name = await this.getSlackRoomNameFromID(id, token);
                text = text.replace(CHANNEL_ID_REGEX_FIRST, "#" + name);
            }
            iteration++;

        }
        return text;
    }

    public async replaceUserIdsWithNames(message: ISlackMessage, text: string|undefined, token: string) {
        if (text === undefined) {
            return text;
        }

        let match = USER_ID_REGEX.exec(text);
        while (match !== null && match[0]) {
            // foreach userId, pull out the ID
            // (if this is an emote msg, the format is <@ID|nick>, but in normal msgs it's just <@ID>
            const id = match[0].match(USER_ID_REGEX_FIRST)![1];

            const teamDomain = await this.main.getTeamDomainForMessage(message);

            let displayName = "";
            const userId = this.main.getUserId(id, teamDomain);

            const store = this.main.userStore;
            const users = await store.select({id: userId});

            if (users === undefined || !users.length) {
                log.warn("Mentioned user not in store. Looking up display name from slack.");
                // if the user is not in the store then we look up the displayname
                const nullGhost = new SlackGhost(this.main);
                const room = this.main.getRoomBySlackChannelId(message.channel);
                displayName = await nullGhost.getDisplayname(id, room!.AccessToken!) || id;
                // If the user is not in the room, we cant pills them, we have to just plain text mention them.
                text = text.replace(USER_ID_REGEX_FIRST, displayName);
            } else {
                displayName = users[0].display_name || userId;
                text = text.replace(
                    USER_ID_REGEX_FIRST,
                    `<https://matrix.to/#/${userId}|${displayName}>`,
                );
            }
            // Check for the next match.
            match = USER_ID_REGEX.exec(text);
        }
        return text;
    }

    /**
     * Enables public sharing on the given file object. then fetches its content.
     *
     * @param {Object} file A slack 'message.file' data object
     * @param {string} token A slack API token that has 'files:write:user' scope
     * @return {Promise<Object>} A Promise of the updated slack file data object
     */
    public async enablePublicSharing(file: ISlackFile, token: string) {
        if (file.public_url_shared) { return file; }

        this.main.incRemoteCallCounter("files.sharedPublicURL");
        const response = await rp({
            form: {
                file: file.id,
                token,
            },
            json: true,
            method: "POST",
            uri: "https://slack.com/api/files.sharedPublicURL",
        });
        if (!response || !response.file || !response.file.permalink_public) {
            log.warn("Could not find sharedPublicURL: " + JSON.stringify(response));
            return;
        }
        return response.file;
    }

    /**
     * Fetches the file at a given url.
     *
     * @param {Object} file A slack 'message.file' data object
     * @return {Promise<string>} A Promise of file contents
     */
    public async fetchFileContent(file: ISlackFile) {
        if (!file) { return; }

        const url = subs.getSlackFileUrl(file) || file.permalink_public;
        if (!url) {
            throw new Error("File doesn't have any URLs we can use.");
        }

        const response = await rp({
            encoding: null,
            resolveWithFullResponse: true,
            uri: url,
        });

        const content = response.body;
        log.debug(`Successfully fetched file ${file.id}  content (${content.length} bytes)`);
        return content;
    }
}
