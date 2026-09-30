## PlaywrightCrawler template

<!-- This is an Apify template readme -->

This template is a production-ready boilerplate for developing an [Actor](https://apify.com/actors) with `PlaywrightCrawler`. Use this to bootstrap your projects using the most up-to-date code.

> We decided to split Apify SDK into two libraries, Crawlee and Apify SDK v3. Crawlee will retain all the crawling and scraping-related tools and will always strive to be the best [web scraping](https://apify.com/web-scraping) library for its community. At the same time, Apify SDK will continue to exist, but keep only the Apify-specific features related to building Actors on the Apify platform. Read the upgrading guide to learn about the changes.

## Resources

If you're looking for examples or want to learn more visit:

- [Crawlee + Apify Platform guide](https://crawlee.dev/docs/guides/apify-platform)
- [Documentation](https://crawlee.dev/api/playwright-crawler/class/PlaywrightCrawler) and [examples](https://crawlee.dev/docs/examples/playwright-crawler)
- [Node.js tutorials](https://docs.apify.com/academy/node-js) in Academy
- [Scraping single-page applications with Playwright](https://blog.apify.com/scraping-single-page-applications-with-playwright/)
- [How to scale Puppeteer and Playwright](https://blog.apify.com/how-to-scale-puppeteer-and-playwright/)
- [Integration with Zapier](https://apify.com/integrations), Make, GitHub, Google Drive and other apps
- [Video guide on getting data using Apify API](https://www.youtube.com/watch?v=ViYYDHSBAKM)
- A short guide on how to create Actors using code templates:

[web scraper template](https://www.youtube.com/watch?v=u-i-Korzf8w)


## Getting started

For complete information [see this article](https://docs.apify.com/platform/actors/development#build-actor-at-apify-console). In short, you will:

1. Build the Actor
2. Run the Actor

## Pull the Actor for local development

If you would like to develop locally, you can pull the existing Actor from Apify console using Apify CLI:

1. Install `apify-cli`

    **Using Homebrew**

    ```bash
    brew install apify-cli
    ```

    **Using NPM**

    ```bash
    npm -g install apify-cli
    ```

2. Pull the Actor by its unique `<ActorId>`, which is one of the following:
    - unique name of the Actor to pull (e.g. "apify/hello-world")
    - or ID of the Actor to pull (e.g. "E2jjCZBezvAZnX8Rb")

    You can find both by clicking on the Actor title at the top of the page, which will open a modal containing both Actor unique name and Actor ID.

    This command will copy the Actor into the current directory on your local machine.

    ```bash
    apify pull <ActorId>
    ```

## Documentation reference

To learn more about Apify and Actors, take a look at the following resources:

- [Apify SDK for JavaScript documentation](https://docs.apify.com/sdk/js)
- [Apify SDK for Python documentation](https://docs.apify.com/sdk/python)
- [Apify Platform documentation](https://docs.apify.com/platform)
- [Join our developer community on Discord](https://discord.com/invite/jyEM2PRvMU)