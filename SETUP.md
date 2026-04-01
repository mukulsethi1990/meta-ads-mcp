# Setup Instructions for Meta Ads MCP

## Getting Started
To get started with the Meta Ads MCP, follow these comprehensive setup instructions:

### Prerequisites
- Ensure you have the latest version of Node.js installed.
- Make sure you have a Meta account with access to the necessary APIs.

### Installation Steps
1. Clone the repository:
   ```bash
   git clone https://github.com/mukulsethi1990/meta-ads-mcp.git
   cd meta-ads-mcp
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Configuring your environment:
   - Create a `.env` file in the root of the directory.
   - Here is a sample content for the `.env` file:
     ```
     META_ACCESS_TOKEN=<your_meta_access_token>
     ```

## Meta Access Token Guide
To interact with the Meta APIs, you need to obtain a Meta Access Token:
- Login to your [Meta for Developers](https://developers.facebook.com/) account.
- Navigate to the 'My Apps' section and create a new app if you don't have one.
- Under your app settings, find the Access Tokens section.
- Generate a User token and copy it into your `.env` file under `META_ACCESS_TOKEN`.

## Configuration Documentation
- The application uses several configuration settings stored in the `.env` file. Ensure the following variables are defined:
  - `META_ACCESS_TOKEN` : Your Meta Access Token.
  
### Example Configuration
```plaintext
META_ACCESS_TOKEN=your_access_token_here
``` 

## Troubleshooting Tips
If you run into issues, here are some common troubleshooting steps:
- Ensure your Node.js version is compatible (Check the `package.json` for required versions).
- Double-check your `.env` file for any syntax errors (missing `=` signs).
- If you receive authentication errors, confirm your Meta Access Token is still active and has the necessary permissions.
- Review console logs for any additional error messages.

For further support, consult the [GitHub Issues](https://github.com/mukulsethi1990/meta-ads-mcp/issues) page or reach out to the maintainers.
