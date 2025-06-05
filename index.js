import axios from 'axios';
import { writeFile, readFile, access } from 'fs/promises';
import { constants } from 'fs';
import { argv, exit } from 'process';
import { createServer } from 'http';
import { parse } from 'url';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export default class YouTubePlaylistExtractor {
    constructor(clientSecretPath = 'client_secret.json', tokenPath = 'token.json') {
        this.clientSecretPath = clientSecretPath;
        this.tokenPath = tokenPath;
        this.baseUrl = 'https://www.googleapis.com/youtube/v3';
        this.credentials = null;
        this.accessToken = null;
    }

    // Initialize the extractor (loads credentials)
    async init() {
        await this.loadCredentials();
    }

    // Check if file exists
    async fileExists(path) {
        try {
            await access(path, constants.F_OK);
            return true;
        } catch {
            return false;
        }
    }

    // Load OAuth credentials from client_secret.json
    async loadCredentials() {
        try {
            const credentialsFile = await readFile(this.clientSecretPath, 'utf8');
            const credentials = JSON.parse(credentialsFile);

            // Handle both installed app and web app credential formats
            if (credentials.installed) {
                this.credentials = credentials.installed;
            } else if (credentials.web) {
                this.credentials = credentials.web;
            } else {
                throw new Error('Invalid client_secret.json format');
            }
        } catch (error) {
            throw new Error(`Failed to load credentials: ${error.message}`);
        }
    }

    // Load existing token or initiate OAuth flow
    async authenticate() {
        // Try to load existing token
        if (await this.fileExists(this.tokenPath)) {
            try {
                const tokenData = JSON.parse(await readFile(this.tokenPath, 'utf8'));

                // Check if token is still valid
                if (this.isTokenValid(tokenData)) {
                    this.accessToken = tokenData.access_token;
                    console.log('✅ Using existing valid token');
                    return;
                }

                // Try to refresh token
                if (tokenData.refresh_token) {
                    console.log('🔄 Refreshing expired token...');
                    await this.refreshToken(tokenData.refresh_token);
                    return;
                }
            } catch (error) {
                console.log('⚠️  Invalid token file, starting new OAuth flow...');
            }
        }

        // Start new OAuth flow
        await this.startOAuthFlow();
    }

    // Check if token is valid (not expired)
    isTokenValid(tokenData) {
        if (!tokenData.expires_at) return false;
        return Date.now() < tokenData.expires_at;
    }

    // Refresh access token using refresh token
    async refreshToken(refreshToken) {
        try {
            const response = await axios.post('https://oauth2.googleapis.com/token', {
                client_id: this.credentials.client_id,
                client_secret: this.credentials.client_secret,
                refresh_token: refreshToken,
                grant_type: 'refresh_token'
            });

            const tokenData = {
                access_token: response.data.access_token,
                refresh_token: refreshToken, // Keep existing refresh token
                expires_at: Date.now() + (response.data.expires_in * 1000)
            };

            this.saveToken(tokenData);
            this.accessToken = tokenData.access_token;
            console.log('✅ Token refreshed successfully');
        } catch (error) {
            console.log('❌ Failed to refresh token, starting new OAuth flow...');
            await this.startOAuthFlow();
        }
    }

    // Start OAuth 2.0 flow
    async startOAuthFlow() {
        const redirectUri = 'http://localhost:8080/callback';
        const scope = 'https://www.googleapis.com/auth/youtube.readonly';

        const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
            `client_id=${this.credentials.client_id}&` +
            `redirect_uri=${encodeURIComponent(redirectUri)}&` +
            `scope=${encodeURIComponent(scope)}&` +
            `response_type=code&` +
            `access_type=offline&` +
            `prompt=consent`;

        console.log('🔐 Starting OAuth flow...');
        console.log('📱 Opening browser for authentication...');

        // Open browser
        try {
            const platform = process.platform;
            if (platform === 'darwin') {
                await execAsync(`open "${authUrl}"`);
            } else if (platform === 'win32') {
                await execAsync(`start "${authUrl}"`);
            } else {
                await execAsync(`xdg-open "${authUrl}"`);
            }
        } catch (error) {
            console.log('❌ Could not open browser automatically');
            console.log(`Please open this URL manually: ${authUrl}`);
        }

        // Start local server to handle callback
        const authCode = await this.startCallbackServer(redirectUri);

        // Exchange authorization code for tokens
        await this.exchangeCodeForTokens(authCode, redirectUri);
    }

    // Start local server to handle OAuth callback
    startCallbackServer(redirectUri) {
        return new Promise((resolve, reject) => {
            const server = createServer((req, res) => {
                const urlParts = parse(req.url, true);

                if (urlParts.pathname === '/callback') {
                    const { code, error } = urlParts.query;

                    if (error) {
                        res.writeHead(400, { 'Content-Type': 'text/html' });
                        res.end('<h1>Authentication Error</h1><p>Access denied or error occurred.</p>');
                        server.close();
                        reject(new Error(`OAuth error: ${error}`));
                        return;
                    }

                    if (code) {
                        res.writeHead(200, { 'Content-Type': 'text/html' });
                        res.end('<h1>Authentication Successful!</h1><p>You can close this window and return to the terminal.</p>');
                        server.close();
                        resolve(code);
                        return;
                    }
                }

                res.writeHead(404, { 'Content-Type': 'text/html' });
                res.end('<h1>Not Found</h1>');
            });

            server.listen(8080, () => {
                console.log('🌐 Callback server started on http://localhost:8080');
            });

            server.on('error', (error) => {
                reject(new Error(`Server error: ${error.message}`));
            });
        });
    }

    // Exchange authorization code for access and refresh tokens
    async exchangeCodeForTokens(code, redirectUri) {
        try {
            const response = await axios.post('https://oauth2.googleapis.com/token', {
                client_id: this.credentials.client_id,
                client_secret: this.credentials.client_secret,
                code,
                grant_type: 'authorization_code',
                redirect_uri: redirectUri
            });

            const tokenData = {
                access_token: response.data.access_token,
                refresh_token: response.data.refresh_token,
                expires_at: Date.now() + (response.data.expires_in * 1000)
            };

            await this.saveToken(tokenData);
            this.accessToken = tokenData.access_token;
            console.log('✅ Authentication successful!');
        } catch (error) {
            throw new Error(`Failed to exchange code for tokens: ${error.message}`);
        }
    }

    // Save token to file
    async saveToken(tokenData) {
        await writeFile(this.tokenPath, JSON.stringify(tokenData, null, 2));
    }

    // Make authenticated API request
    async makeAuthenticatedRequest(endpoint, params = {}) {
        if (!this.accessToken) {
            throw new Error('Not authenticated. Call authenticate() first.');
        }

        try {
            const response = await axios.get(`${this.baseUrl}${endpoint}`, {
                params,
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`
                }
            });
            return response;
        } catch (error) {
            if (error.response?.status === 401) {
                throw new Error('Authentication failed. Token may be invalid.');
            }
            throw error;
        }
    }

    // Extract playlist ID from various YouTube playlist URL formats
    extractPlaylistId(url) {
        const patterns = [
            /[?&]list=([a-zA-Z0-9_-]+)/,
            /\/playlist\?list=([a-zA-Z0-9_-]+)/,
            /^([a-zA-Z0-9_-]+)$/ // Direct playlist ID
        ];

        for (const pattern of patterns) {
            const match = url.match(pattern);
            if (match) return match[1];
        }

        throw new Error('Invalid playlist URL or ID');
    }

    // Fetch all videos from a playlist (handles pagination)
    async getPlaylistVideos(playlistId) {
        const videos = [];
        let nextPageToken = '';

        do {
            try {
                const response = await this.makeAuthenticatedRequest('/playlistItems', {
                    playlistId,
                    part: 'snippet',
                    maxResults: 50,
                    pageToken: nextPageToken
                });

                const items = response.data.items || [];

                for (const item of items) {
                    const { snippet } = item;

                    // Skip deleted/private videos
                    if (snippet.title === 'Private video' || snippet.title === 'Deleted video') {
                        continue;
                    }

                    videos.push({
                        title: snippet.title,
                        videoId: snippet.resourceId.videoId,
                        url: `https://www.youtube.com/watch?v=${snippet.resourceId.videoId}`,
                        thumbnail: snippet.thumbnails?.medium?.url || '',
                        publishedAt: snippet.publishedAt,
                        channelTitle: snippet.channelTitle,
                        position: snippet.position
                    });
                }

                nextPageToken = response.data.nextPageToken || '';
            } catch (error) {
                if (error.response?.status === 404) {
                    throw new Error('Playlist not found or is private');
                } else if (error.response?.status === 403) {
                    throw new Error('Access forbidden - check playlist permissions');
                }
                throw error;
            }
        } while (nextPageToken);

        return videos;
    }

    // Get playlist metadata
    async getPlaylistInfo(playlistId) {
        try {
            const response = await this.makeAuthenticatedRequest('/playlists', {
                id: playlistId,
                part: 'snippet,contentDetails'
            });

            const playlist = response.data.items?.[0];
            if (!playlist) {
                throw new Error('Playlist not found');
            }

            return {
                title: playlist.snippet.title,
                description: playlist.snippet.description,
                channelTitle: playlist.snippet.channelTitle,
                videoCount: playlist.contentDetails.itemCount,
                publishedAt: playlist.snippet.publishedAt,
                privacy: playlist.snippet.privacyStatus || 'unknown'
            };
        } catch (error) {
            throw new Error(`Failed to get playlist info: ${error.message}`);
        }
    }

    // Main extraction method
    async extractPlaylist(playlistUrl, options = {}) {
        const {
            outputFile = null,
            format = 'json',
            includeMetadata = true
        } = options;

        try {
            // Initialize and authenticate first
            await this.init();
            await this.authenticate();

            console.log('🔍 Extracting playlist ID...');
            const playlistId = this.extractPlaylistId(playlistUrl);
            console.log(`📋 Playlist ID: ${playlistId}`);

            const result = {};

            if (includeMetadata) {
                console.log('📊 Fetching playlist metadata...');
                result.playlistInfo = await this.getPlaylistInfo(playlistId);
                console.log(`📺 Playlist: "${result.playlistInfo.title}" (${result.playlistInfo.videoCount} videos)`);
            }

            console.log('🎥 Fetching videos...');
            result.videos = await this.getPlaylistVideos(playlistId);
            console.log(`✅ Extracted ${result.videos.length} videos`);

            // Output results
            if (outputFile) {
                await this.saveToFile(result, outputFile, format);
                console.log(`💾 Results saved to ${outputFile}`);
            }

            return result;

        } catch (error) {
            console.error('❌ Error:', error.message);
            throw error;
        }
    }

    // Save results to file
    async saveToFile(data, filename, format) {
        let content;

        switch (format.toLowerCase()) {
            case 'json':
                content = JSON.stringify(data, null, 2);
                break;
            case 'csv':
                content = this.convertToCSV(data.videos);
                break;
            case 'txt':
                content = this.convertToText(data);
                break;
            default:
                throw new Error('Unsupported format. Use json, csv, or txt');
        }

        await writeFile(filename, content, 'utf8');
    }

    // Convert to CSV format
    convertToCSV(videos) {
        const headers = ['Title', 'URL', 'Video ID', 'Channel', 'Published At', 'Position'];
        const rows = videos.map(video => [
            `"${video.title.replace(/"/g, '""')}"`,
            video.url,
            video.videoId,
            `"${video.channelTitle.replace(/"/g, '""')}"`,
            video.publishedAt,
            video.position
        ]);

        return [headers.join(','), ...rows.map(row => row.join(','))].join('\n');
    }

    // Convert to text format
    convertToText(data) {
        let text = '';

        if (data.playlistInfo) {
            text += `Playlist: ${data.playlistInfo.title}\n`;
            text += `Channel: ${data.playlistInfo.channelTitle}\n`;
            text += `Videos: ${data.playlistInfo.videoCount}\n`;
            text += `Privacy: ${data.playlistInfo.privacy}\n`;
            text += `Published: ${data.playlistInfo.publishedAt}\n\n`;
        }

        text += 'Videos:\n';
        text += '='.repeat(50) + '\n\n';

        data.videos.forEach((video, index) => {
            text += `${index + 1}. ${video.title}\n`;
            text += `   URL: ${video.url}\n`;
            text += `   Channel: ${video.channelTitle}\n`;
            text += `   Published: ${video.publishedAt}\n\n`;
        });

        return text;
    }
}

// CLI Usage Function
const main = async () => {
    const args = argv.slice(2);

    if (args.length < 1) {
        console.log(`
🎬 YouTube Playlist Extractor (OAuth)

Usage: node playlist-extractor.js <PLAYLIST_URL> [OPTIONS]

Arguments:
  PLAYLIST_URL YouTube playlist URL or ID

Options:
  --output, -o       Output file path
  --format, -f       Output format (json, csv, txt) [default: json]
  --no-metadata      Skip playlist metadata
  --client-secret    Path to client_secret.json [default: client_secret.json]
  --token-file       Path to token file [default: token.json]

Setup:
  1. Create OAuth credentials at https://console.cloud.google.com/
  2. Download client_secret.json to current directory
  3. Enable YouTube Data API v3

Examples:
  node playlist-extractor.js "https://www.youtube.com/playlist?list=PLrAXtmRdnEQy"
  node playlist-extractor.js PLrAXtmRdnEQy --output results.json
  node playlist-extractor.js PLrAXtmRdnEQy --format csv --output playlist.csv
        `);
        exit(1);
    }

    const [playlistUrl, ...optionArgs] = args;

    // Parse options
    const options = {};
    let clientSecretPath = 'client_secret.json';
    let tokenPath = 'token.json';

    for (let i = 0; i < optionArgs.length; i++) {
        switch (optionArgs[i]) {
            case '--output':
            case '-o':
                options.outputFile = optionArgs[++i];
                break;
            case '--format':
            case '-f':
                options.format = optionArgs[++i];
                break;
            case '--no-metadata':
                options.includeMetadata = false;
                break;
            case '--client-secret':
                clientSecretPath = optionArgs[++i];
                break;
            case '--token-file':
                tokenPath = optionArgs[++i];
                break;
        }
    }

    try {
        const extractor = new YouTubePlaylistExtractor(clientSecretPath, tokenPath);
        const result = await extractor.extractPlaylist(playlistUrl, options);

        // if (!options.outputFile) {
        //     console.log('\n📋 Results:');
        //     console.log(JSON.stringify(result, null, 2));
        // }

        for (const video of result.videos) {
            console.log(`<p><label><input type="checkbox"> </label><a href="${video.url}">${video.title}</a></p>`);
        }

    } catch (error) {
        console.error('❌ Failed to extract playlist:', error.message);
        exit(1);
    }
};

// Run if this is the main module
if (import.meta.url === `file://${argv[1]}`) {
    main();
}
