# **GitHub Profile Finder**

A lightweight, responsive web application that uses the GitHub REST API to fetch and display user profile information and repository statistics in a clean, modern interface.

## **Features**

* **Real-time Search**: Fetch any public GitHub user's data instantly.  
* **Detailed Stats**: View follower counts, following counts, public repository numbers, and gists.  
* **Metadata Visibility**: Displays user location, blog/website links, Twitter handles, and company information.  
* **Top Repositories**: Automatically fetches and lists the 6 most recently updated repositories.  
* **Loading UI**: Includes a visual spinner to indicate data fetching status.  
* **Responsive Design**: Mobile-first approach using Tailwind CSS, optimised for all screen sizes.  
* **Glassmorphism Theme**: Uses GitHub's "Dark Dimmed" aesthetic with modern glass-style cards.

## **How to Use**

1. Open https://mrlipx.github.io/github-user-lookup in any modern web browser.  
2. Enter a GitHub username (e.g., octocat or facebook) in the search bar.  
3. Press **Enter** or click **Search**.

## **Technical Details**

* **Frontend**: HTML5, Tailwind CSS  
* **Icons**: Font Awesome 6  
* **API**: [GitHub REST API](https://docs.github.com/en/rest)  
* **Deployment**: Can be hosted on GitHub Pages, Netlify, or Vercel by simply uploading the index.html file.

## **Note on API Limits**

GitHub's public API allows for **60 requests per hour** for unauthenticated requests. If you exceed this limit, the application may temporarily stop returning results until your window resets.
