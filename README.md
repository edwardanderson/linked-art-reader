# Linked Art Reader

A generic reader for [Linked Art](https://linked.art/) APIs.

The reader adheres to the [Protocol](https://linked.art/api/1.0/protocol/).

For any given resource, the Linked Art Reader collects data from referenced resources to build the page being viewed. The viewed page is not restricted to the API partition structure.

Where content is available in multiple languages, the reader should privilege the content in the user's own language.

While each resource type may have data elements that concern only that type, the basic page is constructed from the [Shared Structures](https://linked.art/api/1.0/shared/) patterns.

The Reader does not reproduce the Linked Art JSON-LD structure as a page, instead it renders particular [shapes](shapes.md) into templated forms. Related resources are fetched dynamically and painted into the page where appropriate.

Because the Reader is a data explorer, it should not render `id` URIs into `href` attributes, as the user should not be directed outside of the application. Instead, the HTML `id` global attribute should be populated. Referenced URIs should be probed to determine if they serve Linked Art, whereupon an `href` can be populated that will direct the user to a page within the Reader application; if the target does not serve Linked Art, the `href` is populated with the referenced `id`.
