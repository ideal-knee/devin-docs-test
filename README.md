# docs-site

A GitHub Pages site for miscellaneous documentation.

## Local development

```
bundle install
bundle exec jekyll serve
```

Then open http://localhost:4000.

## Adding a page

Create a Markdown file at the repo root (or in a subdirectory) with front matter:

```
---
title: My Page
layout: default
---
```

Pages are published automatically on push to `main`.
