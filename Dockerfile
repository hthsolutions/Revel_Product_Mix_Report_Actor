FROM apify/actor-node-playwright-chrome:latest
ENV NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false

# No lockfile? copy only package.json and use `npm install`
COPY package.json ./
RUN npm install --omit=dev

# now copy the rest
COPY . ./

CMD ["npm", "start"]