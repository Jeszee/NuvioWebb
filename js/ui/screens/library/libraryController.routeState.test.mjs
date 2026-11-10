import assert from "node:assert/strict";
import test from "node:test";

globalThis.__NUVIO_PLATFORM__ = "browser";
globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {}
};

const { libraryRepository, LibrarySourceMode } = await import(
  "../../../data/repository/libraryRepository.js"
);
const { watchedItemsRepository } = await import("../../../data/repository/watchedItemsRepository.js");
const { LibraryController, LIBRARY_PRESENTATION_MODE, LIBRARY_VIEW_MODE } = await import(
  "./libraryController.js"
);

async function withLibraryFixture(fixture, run) {
  const originals = {
    getSourceMode: libraryRepository.getSourceMode,
    getListTabs: libraryRepository.getListTabs,
    getItems: libraryRepository.getItems,
    refreshNow: libraryRepository.refreshNow,
    hydrateItems: libraryRepository.hydrateItems,
    getWatchedItems: watchedItemsRepository.getAll
  };
  libraryRepository.getSourceMode = async () => fixture.sourceMode;
  libraryRepository.getListTabs = async () => fixture.listTabs || [];
  libraryRepository.getItems = fixture.getItems || (async () => fixture.items || []);
  libraryRepository.refreshNow = fixture.refreshNow || (async () => {});
  libraryRepository.hydrateItems = fixture.hydrateItems || (async (items) => items);
  watchedItemsRepository.getAll = async () => [];
  try {
    await run();
  } finally {
    libraryRepository.getSourceMode = originals.getSourceMode;
    libraryRepository.getListTabs = originals.getListTabs;
    libraryRepository.getItems = originals.getItems;
    libraryRepository.refreshNow = originals.refreshNow;
    libraryRepository.hydrateItems = originals.hydrateItems;
    watchedItemsRepository.getAll = originals.getWatchedItems;
  }
}

test("LibraryController captures and hydrates serializable route-level selections", () => {
  const controller = new LibraryController();
  try {
    const restored = controller.hydrateFromRouteState({
      viewMode: LIBRARY_VIEW_MODE.CLOUD,
      presentationMode: LIBRARY_PRESENTATION_MODE.GROUPED,
      sourceMode: "simkl",
      selectedListKey: "watching",
      selectedTypeKey: "series",
      selectedGenre: "drama",
      selectedYear: "2024",
      selectedSortKey: "title_asc",
      selectedCloudProviderId: "provider-a",
      selectedCloudType: "video",
      cloudSearchQuery: "moana"
    });
    assert.equal(restored, true);
    assert.deepEqual(controller.captureRouteState(), {
      viewMode: LIBRARY_VIEW_MODE.CLOUD,
      presentationMode: LIBRARY_PRESENTATION_MODE.GROUPED,
      sourceMode: "local",
      selectedListKey: "watching",
      selectedTypeKey: "series",
      selectedGenre: "drama",
      selectedYear: "2024",
      selectedSortKey: "title_asc",
      selectedCloudProviderId: "provider-a",
      selectedCloudType: "video",
      cloudSearchQuery: "moana"
    });
  } finally {
    controller.dispose();
  }
});

test("LibraryController safely normalizes malformed route state", () => {
  const controller = new LibraryController();
  try {
    assert.equal(controller.hydrateFromRouteState(null), false);
    assert.equal(controller.hydrateFromRouteState({
      viewMode: "unexpected",
      presentationMode: "unexpected",
      selectedTypeKey: "",
      selectedSortKey: ""
    }), true);
    const state = controller.captureRouteState();
    assert.equal(state.viewMode, LIBRARY_VIEW_MODE.SAVED);
    assert.equal(state.presentationMode, LIBRARY_PRESENTATION_MODE.FLAT);
    assert.equal(state.selectedTypeKey, "__all__");
    assert.equal(state.selectedSortKey, "added_desc");
  } finally {
    controller.dispose();
  }
});

test("LibraryController applies a restored logical state only after its first loaded options exist", async () => {
  await withLibraryFixture(
    {
      sourceMode: LibrarySourceMode.TRAKT,
      listTabs: [
        { key: "watchlist", title: "Watchlist", type: "watchlist" },
        { key: "favorites", title: "Favorites", type: "personal" }
      ],
      items: [
        {
          id: "movie-1",
          itemId: "movie-1",
          type: "movie",
          title: "Example",
          year: 2024,
          genres: ["Drama"],
          listKeys: ["favorites"]
        }
      ]
    },
    async () => {
      const controller = new LibraryController();
      try {
        controller.hydrateFromRouteState({
          viewMode: LIBRARY_VIEW_MODE.SAVED,
          presentationMode: LIBRARY_PRESENTATION_MODE.GROUPED,
          selectedListKey: "favorites",
          selectedTypeKey: "movie",
          selectedGenre: "Drama",
          selectedYear: "2024",
          selectedSortKey: "title_asc"
        });
        await controller.init();
        assert.deepEqual(controller.captureRouteState(), {
          viewMode: LIBRARY_VIEW_MODE.SAVED,
          presentationMode: LIBRARY_PRESENTATION_MODE.GROUPED,
          sourceMode: LibrarySourceMode.TRAKT,
          selectedListKey: "favorites",
          selectedTypeKey: "movie",
          selectedGenre: "Drama",
          selectedYear: "2024",
          selectedSortKey: "title_asc",
          selectedCloudProviderId: null,
          selectedCloudType: null,
          cloudSearchQuery: ""
        });
      } finally {
        controller.dispose();
      }
    }
  );
});

test("LibraryController falls back safely when restored loaded-state selections are no longer available", async () => {
  await withLibraryFixture(
    {
      sourceMode: LibrarySourceMode.TRAKT,
      listTabs: [{ key: "watchlist", title: "Watchlist", type: "watchlist" }],
      items: [{ id: "movie-1", itemId: "movie-1", type: "movie", title: "Example", year: 2024 }]
    },
    async () => {
      const controller = new LibraryController();
      try {
        controller.hydrateFromRouteState({
          selectedListKey: "removed-list",
          selectedTypeKey: "missing-type",
          selectedGenre: "Missing",
          selectedYear: "1999",
          selectedSortKey: "missing-sort"
        });
        await controller.init();
        const state = controller.captureRouteState();
        assert.equal(state.selectedListKey, "watchlist");
        assert.equal(state.selectedTypeKey, "__all__");
        assert.equal(state.selectedGenre, null);
        assert.equal(state.selectedYear, null);
        assert.equal(state.selectedSortKey, "default");
      } finally {
        controller.dispose();
      }
    }
  );
});

test("LibraryController validates restored genre and year after metadata hydration supplies their options", async () => {
  const rawItems = [
    { id: "movie-1", itemId: "movie-1", type: "movie", title: "Example", listKeys: ["watchlist"] }
  ];
  const enrichedItems = [
    {
      ...rawItems[0],
      genres: ["Action"],
      year: 2024,
      releaseInfo: "2024",
      imdbRating: 8
    }
  ];
  await withLibraryFixture(
    {
      sourceMode: LibrarySourceMode.TRAKT,
      listTabs: [{ key: "watchlist", title: "Watchlist", type: "watchlist" }],
      items: rawItems,
      hydrateItems: async (items, { onBatch }) => {
        onBatch?.(enrichedItems);
        return enrichedItems;
      }
    },
    async () => {
      const controller = new LibraryController();
      try {
        controller.hydrateFromRouteState({
          selectedTypeKey: "movie",
          selectedGenre: "Action",
          selectedYear: "2024",
          selectedSortKey: "title_asc"
        });
        await controller.init();
        await Promise.resolve();
        await Promise.resolve();
        const state = controller.captureRouteState();
        assert.equal(state.selectedTypeKey, "movie");
        assert.equal(state.selectedGenre, "Action");
        assert.equal(state.selectedYear, "2024");
        assert.equal(state.selectedSortKey, "title_asc");
      } finally {
        controller.dispose();
      }
    }
  );
});

test("LibraryController clears loading state and exposes an error when library loading fails", async () => {
  await withLibraryFixture(
    {
      sourceMode: LibrarySourceMode.MDBLIST,
      getItems: async () => {
        throw new Error("Could not connect to MDBList. Check your connection and try again.");
      }
    },
    async () => {
      const controller = new LibraryController();
      try {
        const loaded = await controller.reload();
        const state = controller.getState();
        assert.equal(loaded, false);
        assert.equal(state.isLoading, false);
        assert.equal(state.isSyncing, false);
        assert.match(state.errorMessage, /Could not connect to MDBList/);
        await controller.refreshNow();
        const refreshedState = controller.getState();
        assert.equal(refreshedState.isLoading, false);
        assert.equal(refreshedState.isSyncing, false);
        assert.match(refreshedState.transientMessage, /Could not connect to MDBList/);
      } finally {
        controller.dispose();
      }
    }
  );
});

test("Simkl status picker filters Saved items and All clears the status filter", async () => {
  const statuses = ["watching", "plantowatch", "completed"];
  const listTabs = statuses.map((status) => ({
    key: `simkl:status:${status}`,
    title: status
  }));
  const items = statuses.flatMap((status) =>
    ["movie", "series"].map((type) => ({
      id: `${status}-${type}`,
      type,
      name: `${status} ${type}`,
      genres: ["Drama"],
      year: 2024,
      listKeys: [`simkl:status:${status}`]
    }))
  );
  await withLibraryFixture(
    { sourceMode: LibrarySourceMode.SIMKL, listTabs, items },
    async () => {
      const controller = new LibraryController();
      try {
        controller.hydrateFromRouteState({
          selectedTypeKey: "movie",
          selectedGenre: "Drama",
          selectedYear: "2024"
        });
        await controller.init();
        assert.equal(controller.getState().selectedTypeKey, "__all__");
        assert.equal(controller.getState().selectedGenre, null);
        assert.equal(controller.getState().selectedYear, null);

        controller.selectList("simkl:status:completed");
        assert.deepEqual(
          controller
            .getState()
            .visibleItems.map((item) => item.id)
            .sort(),
          ["completed-movie", "completed-series"]
        );
        assert.equal(controller.getEmptyStateTitle(), "No titles in completed");

        controller.selectList("__all__");
        assert.equal(controller.getState().selectedListKey, null);
        assert.equal(controller.getState().visibleItems.length, statuses.length * 2);
        assert.equal(controller.getSelectedListLabel(), "All");
      } finally {
        controller.dispose();
      }
    }
  );
});

test("LibraryController clears active facets without changing ordinary filter state mechanics", () => {
  const controller = new LibraryController();
  try {
    controller.state = {
      ...controller.state,
      selectedTypeKey: "movie",
      selectedGenre: "Thriller",
      selectedYear: "2024",
      expandedPicker: "genre",
      pickerFocusIndex: 3
    };

    assert.equal(controller.clearFilters(), true);
    assert.equal(controller.state.selectedTypeKey, "__all__");
    assert.equal(controller.state.selectedGenre, null);
    assert.equal(controller.state.selectedYear, null);
    assert.equal(controller.state.expandedPicker, null);
    assert.equal(controller.state.pickerFocusIndex, 0);
  } finally {
    controller.dispose();
  }
});
