const axios = require('axios');
const fs = require('fs');

class YouTubePlaylistExtractor {
    constructor(apiKey) {
        this.apiKey = apiKey;
        this.baseUrl = 'https://www.googleapis.com/youtube/v3';
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
                const response = await axios.get(`${this.baseUrl}/playlistItems`, {
                    params: {
                        key: this.apiKey,
                        playlistId: playlistId,
                        part: 'snippet',
                        maxResults: 50, // Max allowed by API
                        pageToken: nextPageToken
                    }
                });

                const items = response.data.items || [];
                
                for (const item of items) {
                    const snippet = item.snippet;
                    
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
                    throw new Error('API quota exceeded or invalid API key');
                }
                throw error;
            }
        } while (nextPageToken);

        return videos;
    }

    // Get playlist metadata
    async getPlaylistInfo(playlistId) {
        try {
            const response = await axios.get(`${this.baseUrl}/playlists`, {
                params: {
                    key: this.apiKey,
                    id: playlistId,
                    part: 'snippet,contentDetails'
                }
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
                publishedAt: playlist.snippet.publishedAt
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
            console.log('🔍 Extracting playlist ID...');
            const playlistId = this.extractPlaylistId(playlistUrl);
            console.log(`📋 Playlist ID: ${playlistId}`);

            let result = {};

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

        fs.writeFileSync(filename, content, 'utf8');
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
            text += `Published: ${data.playlistInfo.publishedAt}\n\n`;
        }

        text += 'Videos:\n';
        text += '=' .repeat(50) + '\n\n';

        data.videos.forEach((video, index) => {
            text += `${index + 1}. ${video.title}\n`;
            text += `   URL: ${video.url}\n`;
            text += `   Channel: ${video.channelTitle}\n`;
            text += `   Published: ${video.publishedAt}\n\n`;
        });

        return text;
    }
}

// CLI Usage Example
async function main() {
    // Get command line arguments
    const args = process.argv.slice(2);
    
    if (args.length < 2) {
        console.log(`
🎬 YouTube Playlist Extractor

Usage: node playlist-extractor.js <API_KEY> <PLAYLIST_URL> [OPTIONS]

Arguments:
  API_KEY      Your YouTube Data API v3 key
  PLAYLIST_URL YouTube playlist URL or ID

Options:
  --output, -o    Output file path
  --format, -f    Output format (json, csv, txt) [default: json]
  --no-metadata   Skip playlist metadata

Examples:
  node playlist-extractor.js YOUR_API_KEY "https://www.youtube.com/playlist?list=PLrAXtmRdnEQy"
  node playlist-extractor.js YOUR_API_KEY PLrAXtmRdnEQy --output results.json
  node playlist-extractor.js YOUR_API_KEY PLrAXtmRdnEQy --format csv --output playlist.csv
        `);
        process.exit(1);
    }

    const apiKey = args[0];
    const playlistUrl = args[1];
    
    // Parse options
    const options = {};
    for (let i = 2; i < args.length; i++) {
        switch (args[i]) {
            case '--output':
            case '-o':
                options.outputFile = args[++i];
                break;
            case '--format':
            case '-f':
                options.format = args[++i];
                break;
            case '--no-metadata':
                options.includeMetadata = false;
                break;
        }
    }

    try {
        const extractor = new YouTubePlaylistExtractor(apiKey);
        const result = await extractor.extractPlaylist(playlistUrl, options);
        
        if (!options.outputFile) {
            console.log('\n📋 Results:');
            console.log(JSON.stringify(result, null, 2));
        }
    } catch (error) {
        console.error('❌ Failed to extract playlist:', error.message);
        process.exit(1);
    }
}

// Export for use as module
module.exports = YouTubePlaylistExtractor;

// Run if called directly
if (require.main === module) {
    main();
}